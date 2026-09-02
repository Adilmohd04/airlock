/**
 * signing.ts — the cryptographic floor under the Staged Agent Authority receipt.
 *
 * See `docs/PROTOCOL.md` §5.4 / §6. Three jobs, all via the platform WebCrypto
 * (`crypto.subtle`) so there is zero third-party crypto dependency to trust or
 * to fetch — which matters for a zero-egress product:
 *
 *   1. Canonicalize an object to deterministic bytes (so two implementations —
 *      here and the standalone verify.html — produce byte-identical input to
 *      the signature).
 *   2. Ed25519 sign / verify over those bytes.
 *   3. A per-install keypair, generated once and persisted, so a receipt is
 *      attributable to *this* install and the vendor cannot forge one after the
 *      fact for a different install.
 *
 * ── Why Ed25519 via WebCrypto ───────────────────────────────────────────────
 * Ed25519 landed in the WebCrypto spec and ships in current Chrome/Edge/Safari
 * and Node 20+. It is small, deterministic, and needs no curve parameters in
 * the receipt. The verifier re-implements exactly this with the same Web APIs,
 * so a receipt verifies anywhere WebCrypto exists, with no library.
 *
 * ── The canonicalization contract (do not "improve" casually) ───────────────
 * `canonicalize` MUST stay byte-for-byte identical to the copy inlined in
 * `public/verify.html`. Object keys are sorted lexicographically at every
 * depth; arrays keep their order; no insignificant whitespace; standard JSON
 * string escaping (which `JSON.stringify` on a single string already provides).
 * Any drift here silently breaks cross-tool verification.
 */

// ── base64url ────────────────────────────────────────────────────────────────

/** Bytes → base64url (no padding). URL/JSON-safe, matches the verifier. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → bytes. */
export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin =
    typeof atob === "function"
      ? atob(b64 + pad)
      : Buffer.from(b64 + pad, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── canonicalization ─────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization. Keys sorted at every level; arrays in
 * order; `undefined` and functions dropped like `JSON.stringify`. This is the
 * exact input to both the signature and every SHA-256 in a receipt.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") return Number.isFinite(v as number) ? String(v) : "null";
  if (t === "boolean") return (v as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => serialize(x ?? null)).join(",")}]`;
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`)
      .join(",")}}`;
  }
  // undefined / function / symbol → not representable
  return "null";
}

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is not available in this environment.");
  }
  return c.subtle;
}

// ── SHA-256 ──────────────────────────────────────────────────────────────────

/** SHA-256 of a string (UTF-8) → hex. Used for the ledger hash + the chain. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const digest = await subtle().digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of the canonical form of an object → hex. */
export async function canonicalSha256Hex(value: unknown): Promise<string> {
  return sha256Hex(canonicalize(value));
}

// ── Ed25519 keypair, persisted per install ───────────────────────────────────

const KEY_STORAGE = "airlock.saa.signingKey.v1";

interface StoredKey {
  /** PKCS8 private key, base64url. */
  privateKey: string;
  /** Raw public key, base64url. */
  publicKey: string;
}

/** In-memory cache so we import the key once per page. */
let cached: { keyPair: CryptoKeyPair; publicKeyB64: string } | null = null;

async function generateKeyPair(): Promise<{
  keyPair: CryptoKeyPair;
  publicKeyB64: string;
}> {
  const s = subtle();
  const kp = (await s.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await s.exportKey("raw", kp.publicKey));
  return { keyPair: kp, publicKeyB64: toBase64Url(pub) };
}

async function persist(kp: CryptoKeyPair, publicKeyB64: string): Promise<void> {
  try {
    const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", kp.privateKey));
    const stored: StoredKey = {
      privateKey: toBase64Url(pkcs8),
      publicKey: publicKeyB64,
    };
    globalThis.localStorage?.setItem(KEY_STORAGE, JSON.stringify(stored));
  } catch {
    // Private window / storage blocked: the key just won't survive a reload.
    // Receipts still verify within the session; a new install-key next time.
  }
}

async function loadPersisted(): Promise<{
  keyPair: CryptoKeyPair;
  publicKeyB64: string;
} | null> {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(KEY_STORAGE) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredKey;
    const s = subtle();
    const priv = await s.importKey(
      "pkcs8",
      fromBase64Url(stored.privateKey) as BufferSource,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    const pub = await s.importKey(
      "raw",
      fromBase64Url(stored.publicKey) as BufferSource,
      { name: "Ed25519" },
      true,
      ["verify"]
    );
    return {
      keyPair: { privateKey: priv, publicKey: pub } as CryptoKeyPair,
      publicKeyB64: stored.publicKey,
    };
  } catch {
    // Corrupt or unsupported stored key — fall through to regenerate.
    return null;
  }
}

/**
 * The per-install signing key. Loads the persisted one, else generates and
 * persists a fresh one. Cached in memory for the page's lifetime.
 */
export async function getInstallKey(): Promise<{
  keyPair: CryptoKeyPair;
  publicKeyB64: string;
}> {
  if (cached) return cached;
  const loaded = await loadPersisted();
  if (loaded) {
    cached = loaded;
    return cached;
  }
  const fresh = await generateKeyPair();
  await persist(fresh.keyPair, fresh.publicKeyB64);
  cached = fresh;
  return cached;
}

// ── sign / verify ─────────────────────────────────────────────────────────────

export interface Signature {
  alg: "Ed25519";
  /** Raw public key, base64url. */
  publicKey: string;
  /** Signature over canonical(payload), base64url. */
  value: string;
}

/**
 * Sign the canonical form of `payload` with the per-install key. Returns the
 * detached signature block that goes into a receipt.
 */
export async function signPayload(payload: unknown): Promise<Signature> {
  const { keyPair, publicKeyB64 } = await getInstallKey();
  const bytes = enc.encode(canonicalize(payload));
  const sig = new Uint8Array(
    await subtle().sign({ name: "Ed25519" }, keyPair.privateKey, bytes as BufferSource)
  );
  return { alg: "Ed25519", publicKey: publicKeyB64, value: toBase64Url(sig) };
}

/**
 * Verify a signature block against the canonical form of `payload`. Pure — no
 * install key involved; it uses the public key embedded in the signature, which
 * is exactly what the offline verifier does. Returns false on any failure
 * (bad signature, unsupported alg, malformed key) rather than throwing.
 */
export async function verifyPayload(
  payload: unknown,
  signature: Signature
): Promise<boolean> {
  try {
    if (signature.alg !== "Ed25519") return false;
    const pub = await subtle().importKey(
      "raw",
      fromBase64Url(signature.publicKey) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const bytes = enc.encode(canonicalize(payload));
    return await subtle().verify(
      { name: "Ed25519" },
      pub,
      fromBase64Url(signature.value) as BufferSource,
      bytes as BufferSource
    );
  } catch {
    return false;
  }
}
