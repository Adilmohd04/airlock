/**
 * Minimal, safe markdown rendering for agent-authored insight reports.
 * `marked` parses; `DOMPurify` scrubs. The report text comes from the model,
 * so it is treated as untrusted content — no raw HTML, no scripts, links forced
 * to open in a new tab with `rel="noopener"`.
 *
 * After sanitizing, `[cite:id]` markers (see `agent/citations.ts`) are turned
 * into clickable evidence chips and run through DOMPurify a second time —
 * belt-and-suspenders, since the chip HTML we generate is already safe by
 * construction (the only interpolated content is a regex-validated id).
 */

import { useMemo, useState, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { injectCitationChips } from "../agent/citations";
import { useActivity } from "../agent/hooks";
import { ActivityRow } from "../components/ActivityLog";
import type { ActivityEntry } from "../agent/activity";

marked.setOptions({ gfm: true, breaks: true });

// Force every link to open in a new tab and drop its opener, so clicking a
// link in an agent-authored report can never navigate the Airlock tab away
// (which would lose the in-memory DuckDB state, proposals, and ledger).
let hookInstalled = false;
function ensureHook(): void {
  if (hookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  hookInstalled = true;
}

const PROSE_TAGS = [
  "h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em",
  "code", "pre", "blockquote", "a", "table", "thead", "tbody", "tr",
  "th", "td", "hr", "br",
];
const PROSE_ATTR = ["href", "target", "rel"];

export function renderMarkdown(src: string, citationEntries: ActivityEntry[] = []): string {
  ensureHook();
  const raw = marked.parse(src, { async: false }) as string;
  const safe = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: PROSE_TAGS,
    ALLOWED_ATTR: PROSE_ATTR,
  });
  const withChips = injectCitationChips(safe, citationEntries);
  // Second pass allows the chip markup we just generated (`button` +
  // data-citation-*) and re-sanitizes everything, including it.
  return DOMPurify.sanitize(withChips, {
    ALLOWED_TAGS: [...PROSE_TAGS, "button"],
    ALLOWED_ATTR: [...PROSE_ATTR, "type", "title", "data-citation-id", "data-citation-ok"],
  });
}

export function Markdown({ source }: { source: string }) {
  const entries = useActivity();
  const html = useMemo(() => renderMarkdown(source, entries), [source, entries]);
  const [openId, setOpenId] = useState<string | null>(null);

  // Event delegation: the prose is one `dangerouslySetInnerHTML` blob, so a
  // single click listener on the wrapper — not per-chip React handlers — is
  // how the citation buttons inside it become interactive.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-citation-id]");
    if (!chip) return;
    const id = chip.dataset.citationId ?? null;
    setOpenId((cur) => (cur === id ? null : id));
  };

  const openEntry = openId ? entries.find((e) => e.id === openId) : undefined;

  return (
    <div>
      <div
        className="airlock-prose"
        onClick={onClick}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {openId && (
        <div className="mt-2 rounded-md border border-ink-800 bg-ink-950 p-1">
          {openEntry ? (
            <>
              <ActivityRow e={openEntry} showArgs />
              {openEntry.kind !== "read" && (
                <p className="px-2 pb-1.5 text-[10px] text-danger">
                  Not a read call — this citation isn't verifiable evidence.
                </p>
              )}
            </>
          ) : (
            <p className="px-2 py-1.5 text-[11px] text-danger">
              No ledger entry "{openId}" — this citation is broken.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
