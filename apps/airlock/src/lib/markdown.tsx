/**
 * Minimal, safe markdown rendering for agent-authored insight reports.
 * `marked` parses; `DOMPurify` scrubs. The report text comes from the model,
 * so it is treated as untrusted content — no raw HTML, no scripts, links forced
 * to open in a new tab with `rel="noopener"`.
 */

import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

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

export function renderMarkdown(src: string): string {
  ensureHook();
  const raw = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em",
      "code", "pre", "blockquote", "a", "table", "thead", "tbody", "tr",
      "th", "td", "hr", "br",
    ],
    ALLOWED_ATTR: ["href", "target", "rel"],
  });
}

export function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className="airlock-prose"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
