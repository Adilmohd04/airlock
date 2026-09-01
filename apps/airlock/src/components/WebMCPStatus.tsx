import { useEffect, useState } from "react";
import { isWebMCPAvailable } from "webmcp-staged";

const READ_TOOLS = 8;
const STAGED_ACTIONS = 11;

/**
 * Shows whether a WebMCP host is present and how the tool surface splits
 * read vs. staged-write — the same distinction ChatGPT surfaces from
 * `readOnlyHint`.
 */
export function WebMCPStatus() {
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<string>("");

  useEffect(() => {
    setAvailable(isWebMCPAvailable());
    setMode(
      (window as unknown as { __airlockWebMCP?: string }).__airlockWebMCP ?? ""
    );
    const onChange = () => setAvailable(isWebMCPAvailable());
    document.addEventListener("modelcontexttoolschange", onChange);
    document.addEventListener("toolchange", onChange);
    return () => {
      document.removeEventListener("modelcontexttoolschange", onChange);
      document.removeEventListener("toolchange", onChange);
    };
  }, []);

  const native = mode === "native";

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1 text-xs"
      title={
        native
          ? "A native WebMCP host is driving this page"
          : "No native host — using the local polyfill for testing"
      }
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          native ? "bg-commit" : available ? "bg-pending" : "bg-ink-500"
        }`}
      />
      <span className="font-medium text-slate-300">
        WebMCP {native ? "connected" : available ? "polyfill" : "off"}
      </span>
      <span className="text-slate-600">·</span>
      <span className="font-mono text-slate-500">
        {READ_TOOLS} read · {STAGED_ACTIONS} staged
      </span>
    </div>
  );
}
