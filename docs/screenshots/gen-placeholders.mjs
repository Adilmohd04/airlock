#!/usr/bin/env node
// gen-placeholders.mjs
//
// Pure-Node placeholder-screenshot generator for the Airlock submission README.
//
// Emits a dark 1440x900 PNG for each of the six target screenshot files, with
// the target filename drawn (centered) as text using a hand-coded bitmap font.
// Uses ONLY the built-in `zlib` module plus a minimal hand-written PNG chunk
// writer -- no new npm dependency.
//
// CRITICAL: each file is written ONLY IF it does not already exist, so a real
// screenshot capture placed at one of these paths is never overwritten.
//
// This script is intentionally side-effect-free at import time; run it with:
//   node docs/screenshots/gen-placeholders.mjs
//
// It does NOT commit anything (that is a separate task).

import { deflateSync } from "node:zlib";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WIDTH = 1440;
const HEIGHT = 900;

// App dark-theme background (near-black, matches ink.* / bg-ink-* tokens).
const BG = { r: 0x0b, g: 0x0f, b: 0x14 };
// Muted foreground for the drawn caption text (airlock.* family).
const FG = { r: 0x9a, g: 0xb2, b: 0xc4 };
// Subtitle color, slightly dimmer.
const FG_DIM = { r: 0x55, g: 0x66, b: 0x74 };

const TARGETS = [
  "01-empty-state.png",
  "02-grid.png",
  "03-review-queue.png",
  "04-activity-ledger.png",
  "05-seal-popover.png",
  "06-agent-console.png",
];

const SUBTITLE = "screenshot pending";

// ---------------------------------------------------------------------------
// Minimal 5x7 bitmap font
//
// Each glyph is 5 columns wide x 7 rows tall, encoded as 7 strings of 5 chars
// where "1" is an on pixel. Only the characters used by the target filenames
// and the subtitle are defined; anything undefined renders as a blank space.
// ---------------------------------------------------------------------------

const FONT = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

// ---------------------------------------------------------------------------
// Framebuffer helpers (24-bit RGB)
// ---------------------------------------------------------------------------

function createCanvas(width, height, bg) {
  // One byte per channel, RGB, row-major.
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3 + 0] = bg.r;
    buf[i * 3 + 1] = bg.g;
    buf[i * 3 + 2] = bg.b;
  }
  return buf;
}

function setPixel(buf, width, x, y, color) {
  if (x < 0 || y < 0 || x >= width) return;
  const idx = (y * width + x) * 3;
  if (idx < 0 || idx + 2 >= buf.length) return;
  buf[idx + 0] = color.r;
  buf[idx + 1] = color.g;
  buf[idx + 2] = color.b;
}

// Draw a string of text with the bitmap font at the given scale, top-left
// origin (x, y). Returns nothing; draws directly into buf.
function drawText(buf, width, text, x, y, scale, color) {
  const upper = text.toUpperCase();
  let cursorX = x;
  const spacing = scale; // 1 glyph-pixel gap between glyphs
  for (const ch of upper) {
    const glyph = FONT[ch] || FONT[" "];
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits[col] === "1") {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              setPixel(
                buf,
                width,
                cursorX + col * scale + sx,
                y + row * scale + sy,
                color
              );
            }
          }
        }
      }
    }
    cursorX += (GLYPH_W + 1) * scale + spacing - scale;
  }
}

// Pixel width of a rendered string at the given scale (mirrors drawText's
// horizontal advance so we can center accurately).
function textWidth(text, scale) {
  const n = text.length;
  if (n === 0) return 0;
  const perGlyph = (GLYPH_W + 1) * scale + scale - scale; // = (GLYPH_W+1)*scale
  // Last glyph doesn't need the trailing inter-glyph gap; approximate with
  // the same advance for simplicity (a few px on the right is invisible on a
  // 1440px-wide dark canvas).
  return n * perGlyph;
}

// ---------------------------------------------------------------------------
// PNG encoding (hand-written chunk writer + zlib deflate)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// CRC-32 (per PNG spec) with a precomputed table.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Encode a 24-bit RGB framebuffer into a valid PNG buffer.
function encodePng(rgb, width, height) {
  // IHDR: width, height, bit depth 8, color type 2 (truecolor), no interlace.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build raw scanlines with a leading filter byte (0 = None) per row.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    rgb.copy(raw, rowStart + 1, y * stride, y * stride + stride);
  }

  const idatData = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idatData),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Placeholder composition
// ---------------------------------------------------------------------------

function buildPlaceholder(fileName) {
  const buf = createCanvas(WIDTH, HEIGHT, BG);

  // Title: the target filename, large and centered.
  const titleScale = 6;
  const titleW = textWidth(fileName, titleScale);
  const titleX = Math.max(0, Math.round((WIDTH - titleW) / 2));
  const titleY = Math.round(HEIGHT / 2 - GLYPH_H * titleScale);
  drawText(buf, WIDTH, fileName, titleX, titleY, titleScale, FG);

  // Subtitle: "screenshot pending", smaller and dimmer, below the title.
  const subScale = 3;
  const subW = textWidth(SUBTITLE, subScale);
  const subX = Math.max(0, Math.round((WIDTH - subW) / 2));
  const subY = titleY + GLYPH_H * titleScale + 40;
  drawText(buf, WIDTH, SUBTITLE, subX, subY, subScale, FG_DIM);

  return encodePng(buf, WIDTH, HEIGHT);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const written = [];
  const skipped = [];

  for (const fileName of TARGETS) {
    const outPath = join(here, fileName);
    if (existsSync(outPath)) {
      skipped.push(fileName);
      continue;
    }
    const png = buildPlaceholder(fileName);
    writeFileSync(outPath, png);
    written.push(fileName);
  }

  console.log("gen-placeholders: placeholder screenshot generation complete");
  console.log(`  destination: ${here}`);
  if (written.length > 0) {
    console.log(`  written (${written.length}):`);
    for (const f of written) console.log(`    + ${f}`);
  } else {
    console.log("  written (0): none");
  }
  if (skipped.length > 0) {
    console.log(`  skipped — already exist (${skipped.length}):`);
    for (const f of skipped) console.log(`    = ${f}`);
  } else {
    console.log("  skipped (0): none");
  }
}

main();
