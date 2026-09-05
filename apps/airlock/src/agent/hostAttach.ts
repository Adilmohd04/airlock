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
 * One synchronous re-check. Fires on a transition to a *new* native host, or
 * when the store disagrees with a native live instance (native was already
 * there at baseline — e.g. present from page load while the store still holds
 * boot-time values — so identity comparison alone would stay silent forever).
 * On firing it flips the bootstrap flag, refreshes agent-mode state (the
 * pill follows), and notifies subscribers (the app re-registers its tools on
 * the native instance). Returns true exactly when it fired. No-ops outside a
 * DOM and when page and store agree — safe to call from any event, beat,
 * poll, or panel-open effect.
 */
export function recheckHostAttach(): boolean {
  // A late native prototype getter hides behind the polyfill's own property;
  // ordinary reads (including the baseline below) would miss it forever.
  revealNativePrototypeHost();
  snapshotBaseline();
  const mc = currentModelContext();
  if (classifyHost(mc) !== "native") return false;
  const storeSaysNative = agentModeStore.getState().host.kind === "native";
  if (mc === baseline && storeSaysNative) return false;
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
 * Plus a slow poll, because a testing host can expose the API minutes after
 * load (on demand) — long after the scheduled beats above have run. The poll
 * clears itself permanently on the first transition, so a connected tab pays
 * one property read every 5s only until it connects. Returns an unsubscribe
 * function that stops everything. No-op without a window.
 */
export const NATIVE_HOST_POLL_MS = 5000;

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
  const poll =
    typeof setInterval === "undefined"
      ? undefined
      : setInterval(() => {
          if (recheckHostAttach() && poll !== undefined) clearInterval(poll);
        }, NATIVE_HOST_POLL_MS);
  return () => {
    window.removeEventListener("focus", onEvent);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onEvent);
    if (poll !== undefined) clearInterval(poll);
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

/**
 * Reveal a native host hiding behind the polyfill's own property.
 *
 * WebIDL attributes such as `document.modelContext` live on
 * `Document.prototype`, while the polyfill installs a configurable own data
 * property on the document instance. If the browser exposes the native API
 * late (e.g. an origin trial activating after bootstrap installed the
 * polyfill), ordinary reads keep returning the polyfill and every recheck
 * misses the transition forever.
 *
 * This removes ONLY a confirmed polyfill shadow and ONLY when the prototype
 * chain currently yields a functional, non-polyfill host. Anything else —
 * no document, no own-property shadow, no prototype getter, a getter that
 * throws or yields anything unusable — leaves the page untouched.
 * Returns true exactly when it unshadowed a native host.
 */
export function revealNativePrototypeHost(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as unknown as Record<string, unknown>;
  const current = doc.modelContext;
  if (
    !current ||
    (current as { __isWebMCPPolyfill?: unknown }).__isWebMCPPolyfill !== true
  ) {
    return false;
  }
  let protoHost: unknown;
  try {
    let proto: unknown = Object.getPrototypeOf(document);
    while (proto && proto !== Object.prototype) {
      const desc = Object.getOwnPropertyDescriptor(proto, "modelContext");
      if (desc) {
        if (typeof desc.get !== "function") return false;
        protoHost = desc.get.call(document);
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
  } catch {
    return false;
  }
  if (classifyHost(protoHost) !== "native") return false;
  try {
    delete doc.modelContext;
  } catch {
    return false;
  }
  return classifyHost(doc.modelContext) === "native";
}

/**
 * Drop a registerTool-less `document.modelContext` stub so the polyfill can
 * install. The polyfill refuses to shadow an existing property, so a dead
 * stub (e.g. injected by a half-working extension — no registerTool, nothing
 * any consumer can call) would otherwise leave the page with no usable API
 * at all: not native, and no testing shim either. A functional instance is
 * never touched. Returns true when a stub was removed. Never throws.
 */
export function removeNonFunctionalStub(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as unknown as Record<string, unknown>;
  const mc = doc.modelContext;
  if (
    !mc ||
    typeof (mc as { registerTool?: unknown }).registerTool === "function"
  ) {
    return false;
  }
  try {
    delete doc.modelContext;
  } catch {
    return false;
  }
  return doc.modelContext === undefined;
}
