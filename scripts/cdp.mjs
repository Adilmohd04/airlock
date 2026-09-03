/**
 * cdp.mjs — minimal Chrome DevTools Protocol driver (raw WebSocket, zero deps;
 * Node's built-in WebSocket client is rejected by Chrome's DevTools server).
 *
 *   node scripts/cdp.mjs '<js expression>'              # evaluate in the app tab
 *   node scripts/cdp.mjs --url <substr> '<expr>'        # pick tab by URL substring
 *   node scripts/cdp.mjs shot <out.png> [url-substr]    # viewport screenshot
 *   node scripts/cdp.mjs --raw '<cdp json>'             # raw CDP command
 */
import net from "node:net";
import crypto from "node:crypto";

function wsConnect(url) {
  const u = new URL(url.replace("ws://", "http://"));
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const socket = net.connect(u.port, u.hostname, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let resolveWaiter = null;
    const queue = [];
    const waiters = [];

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const idx = buffer.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buffer.slice(0, idx).toString();
        if (!/HTTP\/1\.1 101/.test(head)) {
          reject(new Error("handshake failed: " + head.split("\r\n")[0]));
          socket.destroy();
          return;
        }
        upgraded = true;
        buffer = buffer.slice(idx + 4);
        resolve({ send: sendFrame, close: () => socket.destroy(), messages: queue });
      }
      // Decode frames
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const op = b0 & 0x0f;
        let len = buffer[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          off = 10;
        }
        if (buffer.length < off + len) return;
        const payload = buffer.slice(off, off + len);
        buffer = buffer.slice(off + len);
        if (op === 1) {
          const text = payload.toString();
          const msg = JSON.parse(text);
          if (waiters.length) waiters.shift()(msg);
          else queue.push(msg);
        } else if (op === 8) {
          socket.destroy();
        }
      }
    });
    socket.on("error", reject);

    function sendFrame(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    }

    // expose waiter registration
    resolve_waiters: {
      socket._waiters = waiters;
      socket._queue = queue;
    }
  });
}

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
let target;
let expr;
const argv = process.argv.slice(2);
// node scripts/cdp.mjs shot <out.png> [url-substr]
let shotOut = null;
if (argv[0] === "shot") {
  shotOut = argv[1];
  const sub = argv[2] ?? "4173";
  target = pages.find((p) => p.type === "page" && p.url.includes(sub));
} else if (argv[0] === "--url") {
  target = pages.find((p) => p.type === "page" && p.url.includes(argv[1]));
  expr = argv[2];
} else {
  target =
    pages.find((p) => p.type === "page" && p.url.includes("4173")) ??
    pages.find((p) => p.type === "page");
  expr = argv[0];
}
if (!target) {
  console.error(
    "no matching page; have:",
    pages.filter((p) => p.type === "page").map((p) => p.url)
  );
  process.exit(1);
}

const ws = await wsConnect(target.webSocketDebuggerUrl);
const id = 1;
if (shotOut) {
  ws.send({ id, method: "Page.captureScreenshot", params: { format: "png" } });
} else {
  ws.send({ id, method: "Runtime.evaluate", params: {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  } });
}
const msg = await new Promise((res, rej) => {
  const check = () => {
    const m = ws.messages.find((x) => x.id === id);
    if (m) res(m);
    else setTimeout(check, 50);
  };
  check();
  setTimeout(() => rej(new Error("cdp timeout")), 120000);
});
ws.close();
if (shotOut) {
  if (msg.error) {
    console.error("CDP ERROR:", JSON.stringify(msg.error).slice(0, 300));
    process.exit(1);
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync(shotOut, Buffer.from(msg.result?.data ?? "", "base64"));
  // Screenshots render at the device pixel ratio (1.5 on the reference
  // machine): divide pixel dims by DPR for CSS px in Input dispatches.
  console.log("wrote " + shotOut);
  process.exit(0);
}
if (msg.result?.exceptionDetails) {
  console.error("PAGE ERROR:", JSON.stringify(msg.result.exceptionDetails).slice(0, 800));
  process.exit(1);
}
console.log(JSON.stringify(msg.result?.result?.value, null, 1));
process.exit(0);
