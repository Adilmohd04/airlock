/**
 * Agent mode — which "brain" drives the agent, and what Airlock can honestly
 * say about where data goes while it does.
 *
 * "The agent works on data that never leaves your browser" is only true in
 * `local` mode, and only once an on-device model is actually loaded. The moment
 * a cloud WebMCP host (ChatGPT desktop / Chrome) calls a tool, the rows and
 * columns that tool returns are in that host's context window — the raw file
 * never leaves, but the queried slices do (NORTH_STAR.md §3). Airlock's own
 * activity ledger measures that exactly (`rowsDisclosed()` / `seenColumns()`).
 *
 * This module exists so every status surface (Seal, WebMCP status, the TopBar
 * tagline) reads one honest state instead of each writing its own claim and
 * drifting out of sync.
 *
 * Same idiom as `agent/activity.ts` / `engine/uiStore.ts`: a class holding a
 * referentially-stable snapshot, `subscribe`, `getState`, and a
 * `useSyncExternalStore` hook. Kept in this file (not `agent/hooks.ts`) so a
 * consumer needs one import.
 *
 * WebMCP's imperative API (`document.modelContext`) exposes no vendor-identity
 * field, so this module never *guesses* a brand name from the user agent — a
 * wrong guess ("ChatGPT" when it is some other native host) is exactly the kind
 * of claim NORTH_STAR.md §3 forbids. A native host is named generically until
 * the user says otherwise (`setHostName`).
 */

import React from "react";
import { isWebMCPAvailable } from "webmcp-staged";

export type AgentMode = "local" | "cloud" | "byo-endpoint";

/**
 * Mirrors `LocalModelStore.status` from T1-a's contract
 * (`agent/localModel/store.ts` — not landed on this branch yet). Kept as a
 * narrow local enum rather than importing that module, so this file has no
 * hard dependency on a store that does not exist here yet. Whoever wires the
 * real runtime calls `setLocalModelStatus` to keep this in sync.
 *
 * Assumed T1-a shape (report reconciles at merge):
 *   interface LocalModelStore {
 *     status: "unavailable" | "not-downloaded" | "downloading" | "ready" | "running";
 *     progress: number;              // 0..1 — not consumed here
 *     activeModel: string | null;
 *     download(): Promise<void>;     // not consumed here
 *     unload(): void;                // not consumed here
 *     subscribe(fn: () => void): () => void;
 *     getState(): { status; progress; activeModel };
 *   }
 * agentMode only needs `status` + `activeModel`, pushed in via
 * `setLocalModelStatus(status, activeModel)`.
 */
export type LocalModelStatus =
  | "unavailable"
  | "not-downloaded"
  | "downloading"
  | "ready"
  | "running";

export type WebMCPHostKind = "native" | "polyfill-only" | "none";

export interface WebMCPHostState {
  kind: WebMCPHostKind;
  /**
   * Display name for a "native" host. Empty string when `kind` is not
   * "native". Starts generic (see file header) — `setHostName` lets the user
   * (or a future host-identity signal) supply a real one.
   */
  name: string;
}

/** UI stub only (BUILD_PROMPT §1.4) — the transport is not wired here. */
export interface ByoEndpointConfig {
  url: string;
  /** Whether a key was entered. The key value itself is never held in this store. */
  hasKey: boolean;
}

export interface AgentModeState {
  mode: AgentMode;
  /** `navigator.gpu` presence — the hard requirement for `local` mode. */
  webgpu: boolean;
  localModelStatus: LocalModelStatus;
  activeModel: string | null;
  host: WebMCPHostState;
  byo: ByoEndpointConfig | null;
}

export interface ModeAvailability {
  available: boolean;
  /** Plain-language reason, always set together with `available: false`. */
  reason?: string;
}

/**
 * Label for a "native" WebMCP host until something more specific is known.
 * Deliberately generic rather than a guessed vendor name.
 */
export const GENERIC_HOST_NAME = "the connected AI host";

// ---------------------------------------------------------------------------
// Pure detection / description logic — no globals touched, directly testable.
// ---------------------------------------------------------------------------

/** True when the environment can run a model on-device via WebGPU. */
export function detectWebGPU(nav?: { gpu?: unknown }): boolean {
  return !!nav?.gpu;
}

/**
 * `flag` is `main.tsx`'s `window.__airlockWebMCP` ("native" | "polyfill" |
 * undefined). `webMCPAvailable` is `isWebMCPAvailable()` — whether
 * `document.modelContext` resolves at all (true for both a native host and the
 * polyfill).
 *
 * A polyfill with no real host attached is neither "cloud" (no host to send
 * data to) nor "local" (no on-device model) — it is the Agent-console dev
 * shim, modelled explicitly as "polyfill-only" rather than defaulted into
 * whichever mode would read best.
 */
export function detectHost(
  flag: string | undefined,
  webMCPAvailable: boolean
): WebMCPHostState {
  if (flag === "native") return { kind: "native", name: GENERIC_HOST_NAME };
  if (flag === "polyfill" && webMCPAvailable)
    return { kind: "polyfill-only", name: "" };
  return { kind: "none", name: "" };
}

/**
 * Whether `mode` can be selected right now. Only `local` is ever gated —
 * `cloud` and `byo-endpoint` are always selectable (their badges say plainly
 * when nothing is actually connected; see `describeMode`).
 *
 * `local` is also blocked whenever a native host is attached. `main.tsx` only
 * installs the polyfill testing shim when there is NO native host, so a
 * page-side local model has no standard channel to call Airlock's tools while
 * a native host owns `document.modelContext`. More important: `tools.tsx`
 * registers unconditionally, so the native host can call every tool no matter
 * what this selector shows — claiming "local" (or worse, "0 bytes out") while
 * that is true is the half-truth §3 forbids.
 *
 * **Assumption for T1-a / T1-b to confirm:** this reads `main.tsx`'s bootstrap
 * as of this branch. Flagged in the T1-d report.
 */
export function computeAvailability(
  mode: AgentMode,
  state: Pick<AgentModeState, "localModelStatus" | "webgpu" | "host">
): ModeAvailability {
  if (mode !== "local") return { available: true };
  if (state.host.kind === "native") {
    return {
      available: false,
      reason:
        "A connected AI host is already driving this page. Local mode can't run " +
        "alongside it — disconnect that host to go fully on-device.",
    };
  }
  if (!state.webgpu) {
    return {
      available: false,
      reason:
        "This browser has no WebGPU, so no model can run on your device here. " +
        "Cloud mode still works; for local, open Airlock in a recent Chrome or " +
        "Edge on desktop.",
    };
  }
  if (state.localModelStatus === "unavailable") {
    return {
      available: false,
      reason:
        "The on-device model runtime isn't available in this browser right now.",
    };
  }
  return { available: true };
}

export interface ModeBadge {
  /** Short text for the status pill. */
  headline: string;
  /** Full sentence for a tooltip / popover — the plain-language claim. */
  detail: string;
}

/**
 * The single source of copy for "what is this mode doing with my data". Every
 * status surface renders this instead of writing its own sentence, so the
 * honesty rule cannot drift between two components.
 *
 * Note: this never emits the literal string "0 bytes out" for the local case.
 * That phrase is a *measured* claim and belongs only to `SealStatus`, which
 * reads the live egress monitor. Here the local-running headline is
 * "Fully local · on-device model".
 */
export function describeMode(state: AgentModeState): ModeBadge {
  // A native host can call any registered tool over its own channel regardless
  // of which mode is selected here (`tools.tsx` registers unconditionally).
  // Its presence is ground truth and always wins the status copy — otherwise
  // selecting "Local" while a host is still attached would visually bury a
  // live connection behind an unrelated preference.
  if (state.host.kind === "native") {
    const n = state.host.name || GENERIC_HOST_NAME;
    return {
      headline: `Cloud · ${n}`,
      detail:
        `${cap(n)} is driving Airlock through WebMCP. Your raw file never leaves ` +
        `this tab, but the rows and columns each query returns are sent to it — ` +
        `that is real disclosure. The activity ledger records every query and how ` +
        `many rows it returned; open it for the exact count.`,
    };
  }

  if (state.mode === "local") {
    if (
      state.localModelStatus === "running" ||
      state.localModelStatus === "ready"
    ) {
      const m = state.activeModel ? ` (${state.activeModel})` : "";
      return {
        headline: "Fully local · on-device model",
        detail:
          `An AI model is running inside this browser tab${m}. It has no network ` +
          `access of its own — your file, your questions and every value it reads ` +
          `stay on this device. The Seal shows the measured network total.`,
      };
    }
    const avail = computeAvailability("local", state);
    if (!avail.available) {
      return { headline: "Local · unavailable", detail: avail.reason! };
    }
    return {
      headline: "Local · model not loaded",
      detail:
        state.localModelStatus === "downloading"
          ? "Downloading the on-device model. The agent can't run until it finishes."
          : "No on-device model yet. Start the download from the model panel — nothing runs until it's ready.",
    };
  }

  if (state.mode === "cloud") {
    // host.kind is "polyfill-only" or "none" here — "native" is handled above.
    return {
      headline: "Cloud · no host connected",
      detail:
        "No AI application is connected to this page. Open Airlock inside a WebMCP " +
        "host such as ChatGPT, or use the built-in Agent console to exercise the " +
        "tools by hand.",
    };
  }

  // byo-endpoint
  const host = state.byo?.url ? hostFromUrl(state.byo.url) : null;
  if (host) {
    return {
      headline: `Endpoint · ${host}`,
      detail:
        `Configured to use your own model endpoint at ${host}. This build doesn't ` +
        `open that connection yet (Tier 2) — nothing is sent to it.`,
    };
  }
  return {
    headline: "Endpoint · not set",
    detail:
      "Add your own OpenAI-compatible endpoint URL and key to use it here. This " +
      "is a preview control; the connection isn't wired up yet.",
  };
}

/**
 * The pill headline for `WebMCPStatus`. "0 bytes out" is a *measured* claim
 * (COLLAB rule 5), so it is only ever returned when the caller passes
 * `egressClear === true` (the live egress monitor reads zero) AND an on-device
 * model is genuinely driving with no native host attached. Every other state
 * defers to `describeMode`. Kept here so the one place that can emit that
 * string is the honesty-controlled module, not a component.
 */
export function measuredHeadline(
  state: AgentModeState,
  egressClear: boolean
): string {
  const localRunning =
    state.host.kind !== "native" &&
    state.mode === "local" &&
    (state.localModelStatus === "running" || state.localModelStatus === "ready");
  if (localRunning && egressClear) return "Fully local · 0 bytes out";
  return describeMode(state).headline;
}

/**
 * The short phrase shown next to the wordmark in `TopBar`. Must obey the same
 * honesty rule as the Seal: the "never leaves your browser" line is only used
 * where it is literally true (an on-device model is driving).
 */
export function taglineFor(state: AgentModeState): string {
  if (state.host.kind === "native") {
    const n = state.host.name || GENERIC_HOST_NAME;
    return `raw file stays in this tab · queried slices go to ${n}`;
  }
  if (
    state.mode === "local" &&
    (state.localModelStatus === "running" || state.localModelStatus === "ready")
  ) {
    return "the agent works on data that never leaves your browser";
  }
  return "your data is read and queried locally, in this tab";
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = () => void;

function detectWebGPUFromEnvironment(): boolean {
  return detectWebGPU(
    typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as { gpu?: unknown })
  );
}

function detectHostFromEnvironment(): WebMCPHostState {
  const flag =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { __airlockWebMCP?: string }).__airlockWebMCP;
  return detectHost(flag, isWebMCPAvailable());
}

/**
 * Exported (not just the singleton below) so tests can construct isolated
 * instances instead of monkeypatching the shared one.
 */
export class AgentModeStore {
  private state: AgentModeState;
  private listeners = new Set<Listener>();
  /**
   * True once T1-a's runtime has pushed a real status via
   * `setLocalModelStatus`. Until then, `refreshDetection` is free to recompute
   * `localModelStatus` from WebGPU presence; after, it never touches it — the
   * runtime is the authority.
   */
  private runtimeReported = false;

  constructor() {
    const webgpu = detectWebGPUFromEnvironment();
    this.state = {
      mode: "cloud",
      webgpu,
      localModelStatus: webgpu ? "not-downloaded" : "unavailable",
      activeModel: null,
      host: detectHostFromEnvironment(),
      byo: null,
    };
  }

  getState = (): AgentModeState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<AgentModeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Availability for `mode` given current state — call before `setMode` to show a reason. */
  availability(mode: AgentMode): ModeAvailability {
    return computeAvailability(mode, this.state);
  }

  /** No-ops (and reports why via the return value) if `mode` is not available. */
  setMode(mode: AgentMode): ModeAvailability {
    const result = this.availability(mode);
    if (result.available) this.set({ mode });
    return result;
  }

  /** Called by the local-model runtime integration to keep this store honest. */
  setLocalModelStatus(
    status: LocalModelStatus,
    activeModel: string | null = this.state.activeModel
  ): void {
    this.runtimeReported = true;
    this.set({ localModelStatus: status, activeModel });
  }

  /** User-supplied label for a connected native host — see file header. */
  setHostName(name: string): void {
    if (this.state.host.kind !== "native") return;
    this.set({
      host: { ...this.state.host, name: name.trim() || GENERIC_HOST_NAME },
    });
  }

  setByoConfig(config: ByoEndpointConfig | null): void {
    this.set({ byo: config });
  }

  /** Re-run WebGPU / WebMCP-host detection (e.g. after the polyfill attaches). */
  refreshDetection(): void {
    const webgpu = detectWebGPUFromEnvironment();
    const host = detectHostFromEnvironment();
    // A native host attaching mid-session outranks a prior "local" selection
    // (see `computeAvailability`) — fall back to "cloud" rather than leave the
    // switcher showing "Local" for a mode that just became unavailable.
    const mode =
      host.kind === "native" && this.state.mode === "local"
        ? "cloud"
        : this.state.mode;
    const patch: Partial<AgentModeState> = { webgpu, host, mode };
    if (!this.runtimeReported) {
      patch.localModelStatus = webgpu ? "not-downloaded" : "unavailable";
    }
    this.set(patch);
  }
}

export const agentModeStore = new AgentModeStore();

export function useAgentMode(): AgentModeState {
  return React.useSyncExternalStore(
    agentModeStore.subscribe,
    agentModeStore.getState,
    agentModeStore.getState
  );
}
