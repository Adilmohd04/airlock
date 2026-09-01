/**
 * Citation markers — the anti-hallucination mechanism for `write_report`.
 *
 * An agent report cites evidence with plain text `[cite:<ledgerEntryId>]`,
 * where the id is one returned by a prior READ tool call (see `activity.ts`).
 * No new evidence store: a citation is just a pointer into the existing
 * transparency ledger, so "click a claim, see the exact query + result" is
 * literally "look up this id in `activityLog`".
 *
 * Marker syntax is deliberately inert markdown: `[cite:...]` starts no marked
 * token (it isn't a link — no trailing `(url)`, no `!`, no `^`), so it
 * round-trips through `marked` as plain text. The id capture group is
 * restricted to the exact charset `rid()` produces (crypto.randomUUID, or the
 * `id-<ts>-<b36>` fallback) — `[A-Za-z0-9_-]+`. That means a marker can never
 * contain a quote, angle bracket or backslash, so every place below that
 * interpolates a captured id into HTML is safe *by construction*, without
 * needing to escape anything. This is pure logic (no DOM) so it is unit
 * tested directly, unlike the DOMPurify-dependent rendering in `lib/markdown`.
 */

import type { ActivityEntry } from "./activity";

const MARKER_SOURCE = "\\[cite:([A-Za-z0-9_-]+)\\]";

/** Always construct a fresh instance — a shared `RegExp` with the `g` flag
 *  carries `lastIndex` state between calls, which is a classic footgun when
 *  the same pattern is reused across `.replace`, `.test` and `.matchAll`. */
function markerRegex(): RegExp {
  return new RegExp(MARKER_SOURCE, "g");
}

export interface CitationRef {
  /** The captured ledger entry id. */
  id: string;
  /** The ledger entry it resolves to, if any. */
  entry: ActivityEntry | undefined;
  /** Only a `read` entry has a query + result worth showing as evidence —
   *  citing a propose/commit/reject/denied entry is treated as unverified. */
  valid: boolean;
}

/** Every `[cite:id]` marker in the report, resolved against the ledger. */
export function extractCitations(
  markdown: string,
  entries: ActivityEntry[]
): CitationRef[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refs: CitationRef[] = [];
  for (const m of markdown.matchAll(markerRegex())) {
    const id = m[1];
    const entry = byId.get(id);
    refs.push({ id, entry, valid: !!entry && entry.kind === "read" });
  }
  return refs;
}

export interface CitationStats {
  /** Numeric-claim lines backed by at least one valid citation. */
  citedClaims: number;
  /** Numeric-claim lines with no citation, or only broken ones. */
  uncitedClaims: number;
  /** Markers anywhere in the doc pointing at a missing/non-read entry. */
  brokenCitations: number;
  /** Total `[cite:*]` markers found, valid or not. */
  totalMarkers: number;
}

// A "claim" is a line containing a digit — headings and scene-setting prose
// aren't the kind of assertion a reader needs to verify; a concrete number is
// the signal that it came from somewhere. Cheap and no NLP, but it is exactly
// the shape of the failure mode this feature exists to catch ("engineering is
// paid 8% below market" — the "8%" is the tell).
const CLAIM_LINE_RE = /\d/;

/** Cited-vs-uncited claim counts, for the human to judge evidence quality
 *  before approving — and the broken-marker count so nothing is silently
 *  dropped or silently accepted. */
export function citationStats(
  markdown: string,
  entries: ActivityEntry[]
): CitationStats {
  const refs = extractCitations(markdown, entries);
  const validById = new Map(refs.map((r) => [r.id, r.valid]));
  const brokenCitations = refs.filter((r) => !r.valid).length;

  let citedClaims = 0;
  let uncitedClaims = 0;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue; // skip headings/blank lines
    if (!CLAIM_LINE_RE.test(line)) continue;
    const markersInLine = [...line.matchAll(markerRegex())];
    const anyValid = markersInLine.some((m) => validById.get(m[1]));
    if (anyValid) citedClaims++;
    else uncitedClaims++;
  }

  return {
    citedClaims,
    uncitedClaims,
    brokenCitations,
    totalMarkers: refs.length,
  };
}

/**
 * Turn `[cite:id]` markers in already-sanitized HTML into numbered chip
 * buttons. Safe to call on DOMPurify's output because the only variable
 * content interpolated — the id — is guaranteed by `MARKER_SOURCE` to match
 * `[A-Za-z0-9_-]+`, and `entry.tool` (used in the tooltip) is always one of
 * our own hardcoded tool-name strings, never agent text. `lib/markdown.tsx`
 * still runs a second DOMPurify pass over the result as defense in depth.
 */
export function injectCitationChips(
  html: string,
  entries: ActivityEntry[]
): string {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const numbering = new Map<string, number>();
  return html.replace(markerRegex(), (_full, id: string) => {
    if (!numbering.has(id)) numbering.set(id, numbering.size + 1);
    const n = numbering.get(id);
    const entry = byId.get(id);
    const ok = !!entry && entry.kind === "read";
    const title = ok ? `evidence: ${entry!.tool}` : `unresolved citation: ${id}`;
    // No `class` attr — styled purely off `data-citation-*` so the DOMPurify
    // allowlist stays as tight as possible.
    return (
      `<button type="button" data-citation-id="${id}" ` +
      `data-citation-ok="${String(ok)}" title="${title}">${n}</button>`
    );
  });
}
