/**
 * Citation-marker test suite (Feature 3: CITATIONS).
 *
 * `agent/citations.ts` is pure string/data logic — no DOM, no DOMPurify — so it
 * runs directly under Vitest's `node` environment like the SQL-guard suite.
 * These tests pin: (a) marker extraction + read/non-read/missing validity,
 * (b) the cited-vs-uncited claim heuristic, and (c) that the chip markup the
 * renderer injects cannot be used to smuggle HTML.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { ActivityEntry } from "../activity";
import {
  extractCitations,
  citationStats,
  injectCitationChips,
} from "../citations";

function entry(over: Partial<ActivityEntry> & { id: string }): ActivityEntry {
  return {
    ts: 0,
    kind: "read",
    tool: "run_sql",
    args: {},
    summary: "5 row(s), 2 column(s) in 3ms.",
    ...over,
  };
}

const READ = entry({ id: "read-1", kind: "read" });
const COMMIT = entry({ id: "commit-1", kind: "commit", tool: "commit_add_filter" });
const LEDGER = [READ, COMMIT];

// ---------------------------------------------------------------------------
// extractCitations — resolution + validity
// ---------------------------------------------------------------------------
describe("extractCitations", () => {
  it("resolves a marker to its ledger entry and marks a read entry valid", () => {
    const refs = extractCitations("Pay gap is 8% [cite:read-1].", LEDGER);
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("read-1");
    expect(refs[0].entry).toBe(READ);
    expect(refs[0].valid).toBe(true);
  });

  it("marks a marker pointing at a non-read entry as invalid", () => {
    const refs = extractCitations("[cite:commit-1]", LEDGER);
    expect(refs[0].entry).toBe(COMMIT);
    expect(refs[0].valid).toBe(false);
  });

  it("marks a marker pointing at a missing entry as invalid with no entry", () => {
    const refs = extractCitations("[cite:does-not-exist]", LEDGER);
    expect(refs[0].entry).toBeUndefined();
    expect(refs[0].valid).toBe(false);
  });

  it("finds every marker, in order, including repeats", () => {
    const refs = extractCitations("[cite:read-1] then [cite:x] then [cite:read-1]", LEDGER);
    expect(refs.map((r) => r.id)).toEqual(["read-1", "x", "read-1"]);
  });

  it("ignores bracket text that is not a well-formed marker", () => {
    // A quote / angle bracket / space breaks the id charset, so nothing matches.
    for (const bad of [
      '[cite:a"onerror=x]',
      "[cite:<script>]",
      "[cite: read-1]",
      "[cite:read 1]",
      "[cite:]",
      "[see:read-1]",
    ]) {
      expect(extractCitations(bad, LEDGER)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// citationStats — the cited-vs-uncited claim heuristic
// ---------------------------------------------------------------------------
describe("citationStats", () => {
  it("counts a numeric line with a valid citation as cited", () => {
    const s = citationStats("Engineering is paid 8% below market [cite:read-1].", LEDGER);
    expect(s.citedClaims).toBe(1);
    expect(s.uncitedClaims).toBe(0);
    expect(s.brokenCitations).toBe(0);
  });

  it("counts a numeric line with no citation as uncited", () => {
    const s = citationStats("Attrition rose to 14% last quarter.", LEDGER);
    expect(s.citedClaims).toBe(0);
    expect(s.uncitedClaims).toBe(1);
  });

  it("counts a numeric line whose only citation is broken as uncited AND flags the broken marker", () => {
    const s = citationStats("Revenue per head is $420k [cite:ghost].", LEDGER);
    expect(s.citedClaims).toBe(0);
    expect(s.uncitedClaims).toBe(1);
    expect(s.brokenCitations).toBe(1);
  });

  it("skips headings and non-numeric prose", () => {
    const md = [
      "# Q3 2026 Review",
      "## Section 2",
      "This paragraph makes no numeric claim at all.",
      "- Median comp is 1.02x market [cite:read-1]",
    ].join("\n");
    const s = citationStats(md, LEDGER);
    expect(s.citedClaims).toBe(1);
    expect(s.uncitedClaims).toBe(0);
  });

  it("reports totalMarkers and brokenCitations across the whole doc", () => {
    const md = "a 1 [cite:read-1]\n\nb 2 [cite:read-1] [cite:ghost]\n\nc 3 [cite:commit-1]";
    const s = citationStats(md, LEDGER);
    expect(s.totalMarkers).toBe(4);
    expect(s.brokenCitations).toBe(2); // ghost + commit-1
    expect(s.citedClaims).toBe(2); // lines a and b (b has one valid)
    expect(s.uncitedClaims).toBe(1); // line c: only a non-read citation
  });
});

// ---------------------------------------------------------------------------
// injectCitationChips — XSS-safety of the generated markup
// ---------------------------------------------------------------------------
describe("injectCitationChips", () => {
  it("replaces a valid marker with a numbered chip button carrying the id", () => {
    const out = injectCitationChips("<p>gap 8% [cite:read-1]</p>", LEDGER);
    expect(out).toContain('data-citation-id="read-1"');
    expect(out).toContain('data-citation-ok="true"');
    expect(out).toContain(">1</button>");
    expect(out).not.toContain("[cite:read-1]");
  });

  it("marks a broken marker with data-citation-ok=false", () => {
    const out = injectCitationChips("<p>[cite:ghost]</p>", LEDGER);
    expect(out).toContain('data-citation-id="ghost"');
    expect(out).toContain('data-citation-ok="false"');
  });

  it("numbers unique ids by first appearance and reuses the number for repeats", () => {
    const out = injectCitationChips("[cite:read-1] [cite:ghost] [cite:read-1]", LEDGER);
    const nums = [...out.matchAll(/>(\d+)<\/button>/g)].map((m) => m[1]);
    expect(nums).toEqual(["1", "2", "1"]);
  });

  it("never emits script / event-handler attributes, for any safe-charset id", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".split("")),
            fc.stringMatching(/^[A-Za-z0-9_-]*$/)
          )
          .map(([head, tail]) => head + tail),
        (id) => {
          const out = injectCitationChips(`x [cite:${id}]`, LEDGER);
          expect(out).not.toMatch(/<script/i);
          expect(out).not.toMatch(/onerror|onclick|onload/i);
          // The id round-trips verbatim into exactly one attribute slot.
          expect(out).toContain(`data-citation-id="${id}"`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("leaves a marker with a quote or angle bracket in the id untouched (no chip, no break-out)", () => {
    const raw = '<p>[cite:a"><img src=x onerror=alert(1)>]</p>';
    const out = injectCitationChips(raw, LEDGER);
    expect(out).toBe(raw); // regex never matched — nothing injected
    expect(out).not.toContain("data-citation-id");
  });
});
