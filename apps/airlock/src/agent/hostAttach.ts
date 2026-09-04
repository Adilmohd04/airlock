/**
 * Late host attach — a WebMCP host that arrives AFTER page load.
 *
 * `main.tsx` checks for a native `document.modelContext` exactly once, at
 * bootstrap. If the host API appears later (the agent engages an already-open
 * tab), the top-bar pill would read "not connected" forever and the tools
 * would stay registered on the polyfill instance, where no real host looks.
 * This module closes that gap: it classifies the live instance, re-checks on
 * focus / visible / pageshow and whenever the AI panel opens, and notifies
 * subscribers exactly once per transition to a native host — so the app can
 * refresh its host state (the pill) and re-register its tools there.
 *
 * What counts as "native": present, exposes a `registerTool` function, and is
 * NOT the polyfill (which marks its own instance `__isWebMCPPolyfill`). Any
 * other state — no API, or the polyfill with nobody driving — is not an
 * attach, and this module stays silent about it.
 */

import { agentModeStore } from "./agentMode";

export type HostKind = "native" | "polyfill" | "absent";

export function classifyHost(mc: unknown): HostKind {
  if (
    !mc ||
    typeof (mc as { registerTool?: unknown }).registerTool !== "function"
  ) {
    return "absent";
  }
  if ((mc as { __isWebMCPPolyfill?: unknown }).__isWebMCPPolyfill === true) {
    return "polyfill";
  }
  return "native";
}

/** Live instance, or undefined where there is no document (SSR, tests). */
function currentModelContext(): unknown {
  if (typeof document === "undefined") return undefined;
  return (document as Document).modelContext as unknown;
}

type Listener = () => void;
const listeners = new Set<Listener>();

// The instance seen when watching began. A transition only counts when the
// live instance is native AND a different object — re-running registration
// against the same instance would churn tools for no reason.
let baselineSeen = false;
let baseline: unknown;

function snapshotBaseline(): void {
  if (!baselineSeen) {
    baselineSeen = true;
    baseline = currentModelContext();
  }
}

/**
 * One synchronous re-check. On a transition to a new native host it flips the
 * bootstrap flag, refreshes agent-mode state (the pill follows), and notifies
 * subscribers (the app re-registers its tools on the native instance).
 * Returns true exactly on transitions. No-ops outside a DOM and when nothing
 * changed — safe to call from any event or panel-open effect.
 */
export function recheckHostAttach(): boolean {
  snapshotBaseline();
  const mc = currentModelContext();
  if (classifyHost(mc) !== "native" || mc === baseline) return false;
  baseline = mc;
  if (typeof window !== "undefined") {
    (window as unknown as { __airlockWebMCP?: string }).__airlockWebMCP =
      "native";
  }
  agentModeStore.refreshDetection();
  for (const l of [...listeners]) l();
  return true;
}

/** Fires the callback once per transition to a native host. */
export function onHostAttach(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Re-check at the moments a late-attaching host would plausibly have
 * appeared: the human returns to the tab (focus / visible / pageshow).
 * No polling. Returns an unsubscribe function. No-op without a window.
 */
export function watchForNativeHost(): () => void {
  snapshotBaseline();
  if (typeof window === "undefined") return () => {};
  const onEvent = (): void => {
    recheckHostAttach();
  };
  const onVisibility = (): void => {
    if (document.visibilityState === "visible") recheckHostAttach();
  };
  window.addEventListener("focus", onEvent);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onEvent);
  return () => {
    window.removeEventListener("focus", onEvent);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onEvent);
  };
}

/**
 * Post-load beats: Chrome activates a trial-gated API asynchronously after it
 * processes the injected token meta, so the API can appear seconds after
 * bootstrap already ran its one check. Re-check on these beats even if the
 * human never leaves the tab (no focus/visibility event would fire then).
 */
export const LATE_RECHECK_DELAYS = [1500, 5000, 15000];

export function scheduleLateRechecks(
  recheck: () => void = recheckHostAttach
): () => void {
  if (typeof setTimeout === "undefined") return () => {};
  const ids: ReturnType<typeof setTimeout>[] = LATE_RECHECK_DELAYS.map((ms) =>
    setTimeout(() => recheck(), ms)
  );
  return () => {
    for (const id of ids) clearTimeout(id);
  };
}

/** Test-only reset for the module-level baseline and listeners. */
export function __resetHostAttachForTests(): void {
  baselineSeen = false;
  baseline = undefined;
  listeners.clear();
}
