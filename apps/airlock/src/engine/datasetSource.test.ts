/**
 * `DatasetSource` <-> `PackedSource` round trip — the persistence-interop seam.
 * `lib/persistence.ts` stores `packSource(...)` in an IndexedDB blob record and
 * rebuilds the table from `unpackSource(...)` on restore, so a binary-sourced
 * session (.parquet) must come back byte-identical, and a pre-binary text
 * snapshot must still unpack.
 */
import { describe, it, expect } from "vitest";
import {
  packSource,
  unpackSource,
  type DatasetSource,
} from "./workspaceStore";

const roundTrip = (src: DatasetSource) =>
  unpackSource(structuredClone(packSource(src)));

describe("packSource / unpackSource", () => {
  it("round-trips csv and json text sources", () => {
    for (const src of [
      { kind: "csv", text: "a,b\n1,2\n" },
      { kind: "json", text: '[{"a":1}]' },
    ] as const) {
      expect(roundTrip(src)).toEqual(src);
    }
  });

  it("round-trips a parquet byte source unchanged", () => {
    const src: DatasetSource = {
      kind: "parquet",
      bytes: new Uint8Array([0x50, 0x41, 0x52, 0x31, 9, 8, 7, 0]),
    };
    const back = roundTrip(src);
    expect(back).toEqual(src);
    expect(back?.kind === "parquet" && Array.from(back.bytes)).toEqual([
      0x50, 0x41, 0x52, 0x31, 9, 8, 7, 0,
    ]);
  });

  it("packs text xor bytes, never both", () => {
    expect(packSource({ kind: "csv", text: "x" }).bytes).toBeUndefined();
    expect(
      packSource({ kind: "parquet", bytes: new Uint8Array([1]) }).text
    ).toBeUndefined();
  });

  it("unpacks a legacy text blob (no bytes field)", () => {
    expect(unpackSource({ kind: "csv", text: "a\n1" })).toEqual({
      kind: "csv",
      text: "a\n1",
    });
  });

  it("returns null when a binary blob lost its bytes (corrupt store)", () => {
    expect(unpackSource({ kind: "parquet" })).toBeNull();
    expect(unpackSource({ kind: "csv" })).toBeNull();
  });
});
