/**
 * attestation.ts — the SAA receipt. The properties that matter for a trust
 * artifact:
 *   - it is signed and self-verifies
 *   - editing ANY field breaks verification (tamper-evidence)
 *   - it contains NO raw value (the §5.3 invariant), enforced at build time
 *   - receipts hash-chain so a sequence is tamper-evident
 *
 * buildReceipt reads live singletons; we seed the activity ledger (its public
 * `add`) and assert on the resulting receipt. No dataset is loaded, so the
 * dataset[] array is empty — fine for these structural properties.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { activityLog } from "../agent/activity";
import {
  buildReceipt,
  verifyReceipt,
  receiptChainHash,
  receiptToJson,
  receiptToPrintableHtml,
  SAA_FORMAT,
} from "./attestation";
import { canonicalize } from "./signing";

const ctx = () => ({ session: { id: "sess-1", startedAt: 1_700_000_000_000 } });

beforeEach(() => {
  activityLog.clear();
});

describe("buildReceipt", () => {
  it("produces a signed saa/0.1 receipt that self-verifies", async () => {
    activityLog.add({ kind: "read", tool: "run_sql", args: { query: "SELECT 1" }, summary: "1 row", returned: { rows: 1, columns: ["a"] } });
    const r = await buildReceipt(ctx());
    expect(r.format).toBe(SAA_FORMAT);
    expect(r.signature.alg).toBe("Ed25519");
    expect(await verifyReceipt(r)).toBe(true);
  });

  it("reflects the ledger disclosure counts", async () => {
    activityLog.add({ kind: "read", tool: "preview_rows", args: {}, summary: "", returned: { rows: 10, columns: ["x", "y"] } });
    activityLog.add({ kind: "read", tool: "run_sql", args: {}, summary: "", returned: { rows: 5, columns: ["y", "z"] } });
    activityLog.add({ kind: "commit", tool: "commit_add_filter", args: {}, summary: "" });
    activityLog.add({ kind: "denied", tool: "commit_x", args: {}, summary: "no" });

    const r = await buildReceipt(ctx());
    expect(r.receipt.disclosure.rowsDisclosed).toBe(15);
    expect(r.receipt.disclosure.distinctColumnsSeen.sort()).toEqual(["x", "y", "z"]);
    expect(r.receipt.disclosure.toolCalls).toBe(4);
    expect(r.receipt.disclosure.commits).toBe(1);
    expect(r.receipt.disclosure.denied).toBe(1);
  });

  it("FAILS verification if any receipt field is edited", async () => {
    const r = await buildReceipt(ctx());
    const tampered = {
      ...r,
      receipt: { ...r.receipt, disclosure: { ...r.receipt.disclosure, rowsDisclosed: 9999 } },
    };
    expect(await verifyReceipt(tampered)).toBe(false);
  });

  it("contains NO raw cell value — only counts, hashes, identifiers", async () => {
    // Seed a ledger entry whose args carry a literal value the agent echoed.
    activityLog.add({
      kind: "read",
      tool: "run_sql",
      args: { query: "SELECT * WHERE ssn = '123-45-6789'" },
      summary: "returned 123-45-6789 for Jane Doe",
      returned: { rows: 1, columns: ["ssn"] },
    });
    const r = await buildReceipt(ctx());
    const serialized = JSON.stringify(r);
    // The literal value and the summary text must not appear anywhere.
    expect(serialized).not.toContain("123-45-6789");
    expect(serialized).not.toContain("Jane Doe");
    // The ledger is represented only by its hash.
    expect(typeof r.receipt.ledgerSha256).toBe("string");
    expect(r.receipt.ledgerSha256).toHaveLength(64);
  });

  it("chains: a second receipt links to the first by canonical hash", async () => {
    const first = await buildReceipt(ctx());
    const link = await receiptChainHash(first);
    const second = await buildReceipt({ ...ctx(), previousReceiptSha256: link });
    expect(second.receipt.previousReceiptSha256).toBe(link);
    expect(link).toHaveLength(64);
    // The link is genuinely the hash of the first body's canonical form.
    expect(await verifyReceipt(second)).toBe(true);
  });

  it("the first receipt has a null previous link", async () => {
    const r = await buildReceipt(ctx());
    expect(r.receipt.previousReceiptSha256).toBeNull();
  });

  it("exports round-trip: JSON parses and re-verifies; HTML is self-contained", async () => {
    const r = await buildReceipt(ctx());
    const json = receiptToJson(r);
    const parsed = JSON.parse(json);
    expect(await verifyReceipt(parsed)).toBe(true);
    const html = receiptToPrintableHtml(r);
    expect(html).toContain("Staged Agent Authority");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
});

describe("canonicalization parity with the verifier contract", () => {
  it("signs over the receipt body, so re-canonicalizing the body matches", async () => {
    const r = await buildReceipt(ctx());
    // The verifier canonicalizes receipt.receipt; that must be stable.
    const c1 = canonicalize(r.receipt);
    const c2 = canonicalize(JSON.parse(JSON.stringify(r.receipt)));
    expect(c1).toBe(c2);
  });
});
