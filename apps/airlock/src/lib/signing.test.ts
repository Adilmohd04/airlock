/**
 * signing.ts — canonicalization determinism + Ed25519 sign/verify + the tamper
 * property that the whole attestation rests on: editing ANY field breaks the
 * signature.
 */

import { describe, it, expect } from "vitest";
import {
  canonicalize,
  canonicalSha256Hex,
  sha256Hex,
  signPayload,
  verifyPayload,
  toBase64Url,
  fromBase64Url,
} from "./signing";

describe("canonicalize", () => {
  it("sorts keys at every depth, independent of insertion order", () => {
    const a = canonicalize({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("drops undefined and functions like JSON but keeps null", () => {
    const s = canonicalize({ a: undefined, b: null, c: 1 });
    expect(s).toBe('{"b":null,"c":1}');
  });

  it("renders non-finite numbers as null", () => {
    expect(canonicalize({ x: Infinity, y: NaN })).toBe('{"x":null,"y":null}');
  });

  it("escapes strings as JSON does", () => {
    expect(canonicalize('he said "hi"')).toBe('"he said \\"hi\\""');
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });
  it("emits no +, / or = padding", () => {
    const s = toBase64Url(new Uint8Array([251, 255, 191]));
    expect(s).not.toMatch(/[+/=]/);
  });
});

describe("sha256", () => {
  it("hashes the empty string to the known digest", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
  it("canonicalSha256Hex is order-independent", async () => {
    const h1 = await canonicalSha256Hex({ a: 1, b: 2 });
    const h2 = await canonicalSha256Hex({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });
});

describe("Ed25519 sign / verify", () => {
  it("a fresh signature verifies against its payload", async () => {
    const payload = { hello: "world", n: 42, nested: { z: [1, 2, 3] } };
    const sig = await signPayload(payload);
    expect(sig.alg).toBe("Ed25519");
    expect(await verifyPayload(payload, sig)).toBe(true);
  });

  it("verifies regardless of key order in the payload (canonical)", async () => {
    const sig = await signPayload({ a: 1, b: 2 });
    expect(await verifyPayload({ b: 2, a: 1 }, sig)).toBe(true);
  });

  it("FAILS if any field of the payload is changed", async () => {
    const payload = { amount: 100, to: "alice" };
    const sig = await signPayload(payload);
    expect(await verifyPayload({ amount: 101, to: "alice" }, sig)).toBe(false);
    expect(await verifyPayload({ amount: 100, to: "bob" }, sig)).toBe(false);
    expect(await verifyPayload({ amount: 100, to: "alice", extra: 1 }, sig)).toBe(false);
  });

  it("FAILS if the signature bytes are tampered", async () => {
    const payload = { x: 1 };
    const sig = await signPayload(payload);
    const bad = { ...sig, value: sig.value.slice(0, -2) + (sig.value.endsWith("A") ? "B" : "A") };
    expect(await verifyPayload(payload, bad)).toBe(false);
  });

  it("FAILS for a non-Ed25519 alg", async () => {
    const sig = await signPayload({ x: 1 });
    expect(await verifyPayload({ x: 1 }, { ...sig, alg: "RS256" as never })).toBe(false);
  });
});
