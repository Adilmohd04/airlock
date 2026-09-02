/**
 * Agent-mode state machine + the honesty rule.
 *
 * Two things are pinned here:
 *  1. The mode model — detection, availability gating, mid-session host attach.
 *  2. NORTH_STAR §3 / COLLAB rule 5: a Cloud (native-host) state can never
 *     render a zero-egress or unqualified "your data never leaves" claim.
 *     `describeMode` / `taglineFor` are the single source of that copy, so
 *     asserting on them covers every surface that renders them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentModeStore,
  GENERIC_HOST_NAME,
  computeAvailability,
  describeMode,
  detectHost,
  detectWebGPU,
  measuredHeadline,
  taglineFor,
  type AgentMode,
  type AgentModeState,
  type LocalModelStatus,
} from "../agentMode";

const BASE: AgentModeState = {
  mode: "cloud",
  webgpu: false,
  localModelStatus: "unavailable",
  activeModel: null,
  host: { kind: "none", name: "" },
  byo: null,
};
const state = (o: Partial<AgentModeState> = {}): AgentModeState => ({ ...BASE, ...o });

// Phrases that must never appear in a native-host ("Cloud") description.
const FORBIDDEN = [
  /0 bytes/i,
  /your data never leaves/i,
  /data never leaves your browser/i,
  /nothing (has )?(left|leaves)/i,
  /nothing is sent/i,
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectWebGPU", () => {
  it("is false without a gpu handle", () => {
    expect(detectWebGPU(undefined)).toBe(false);
    expect(detectWebGPU({})).toBe(false);
  });
  it("is true when navigator.gpu is present", () => {
    expect(detectWebGPU({ gpu: {} })).toBe(true);
  });
});

describe("detectHost", () => {
  it("maps the native flag to a native host with a generic name", () => {
    expect(detectHost("native", false)).toEqual({
      kind: "native",
      name: GENERIC_HOST_NAME,
    });
  });
  it("maps the polyfill flag to polyfill-only only when WebMCP resolves", () => {
    expect(detectHost("polyfill", true)).toEqual({ kind: "polyfill-only", name: "" });
    expect(detectHost("polyfill", false)).toEqual({ kind: "none", name: "" });
  });
  it("is 'none' with no flag", () => {
    expect(detectHost(undefined, true)).toEqual({ kind: "none", name: "" });
  });
});

describe("computeAvailability", () => {
  it("never gates cloud or byo-endpoint", () => {
    for (const m of ["cloud", "byo-endpoint"] as AgentMode[]) {
      expect(computeAvailability(m, state({ webgpu: false })).available).toBe(true);
      expect(
        computeAvailability(m, state({ host: { kind: "native", name: "X" } })).available
      ).toBe(true);
    }
  });

  it("blocks local when a native host is attached, with a plain reason", () => {
    const r = computeAvailability(
      "local",
      state({ webgpu: true, localModelStatus: "ready", host: { kind: "native", name: "X" } })
    );
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/connected AI host/i);
  });

  it("blocks local without WebGPU and names WebGPU in the reason", () => {
    const r = computeAvailability("local", state({ webgpu: false }));
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/WebGPU/);
  });

  it("blocks local when the runtime reports unavailable despite WebGPU", () => {
    const r = computeAvailability(
      "local",
      state({ webgpu: true, localModelStatus: "unavailable" })
    );
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/runtime/i);
  });

  it("allows local once WebGPU is present and a model is at least downloadable", () => {
    for (const st of ["not-downloaded", "downloading", "ready", "running"] as LocalModelStatus[]) {
      expect(
        computeAvailability("local", state({ webgpu: true, localModelStatus: st })).available
      ).toBe(true);
    }
  });
});

describe("describeMode — the honesty rule", () => {
  const nativeStates: AgentModeState[] = [
    state({ host: { kind: "native", name: GENERIC_HOST_NAME } }),
    state({ mode: "local", localModelStatus: "running", webgpu: true, host: { kind: "native", name: GENERIC_HOST_NAME } }),
    state({ mode: "byo-endpoint", host: { kind: "native", name: "acme-proxy" }, byo: { url: "https://acme.example/v1", hasKey: true } }),
  ];

  it("never emits a zero-egress or unqualified 'never leaves' claim for a native host", () => {
    for (const st of nativeStates) {
      const b = describeMode(st);
      const text = `${b.headline}\n${b.detail}`;
      for (const re of FORBIDDEN) expect(text).not.toMatch(re);
    }
  });

  it("names the host and points at the ledger for a native host", () => {
    const b = describeMode(state({ host: { kind: "native", name: "ChatGPT" } }));
    expect(b.headline).toContain("ChatGPT");
    expect(b.detail).toMatch(/ledger/i);
    expect(b.detail).toMatch(/sent to it/i);
  });

  it("keeps 'Cloud' framing even when 'local' is the selected mode but a host is attached", () => {
    const b = describeMode(
      state({ mode: "local", localModelStatus: "ready", webgpu: true, host: { kind: "native", name: GENERIC_HOST_NAME } })
    );
    expect(b.headline.startsWith("Cloud")).toBe(true);
  });
});

describe("describeMode — local + byo + cloud", () => {
  it("does not put the measured '0 bytes out' string in the local badge (that is SealStatus's job)", () => {
    const b = describeMode(state({ mode: "local", localModelStatus: "running", webgpu: true }));
    expect(b.headline).toBe("Fully local · on-device model");
    expect(`${b.headline} ${b.detail}`).not.toMatch(/0 bytes/i);
  });

  it("explains a not-yet-loaded local model", () => {
    const b = describeMode(state({ mode: "local", localModelStatus: "not-downloaded", webgpu: true }));
    expect(b.headline).toMatch(/not loaded/i);
  });

  it("surfaces the no-WebGPU reason in the local badge", () => {
    const b = describeMode(state({ mode: "local", localModelStatus: "unavailable", webgpu: false }));
    expect(b.headline).toMatch(/unavailable/i);
    expect(b.detail).toMatch(/WebGPU/);
  });

  it("says plainly when Cloud is selected with no host connected", () => {
    const b = describeMode(state({ mode: "cloud", host: { kind: "polyfill-only", name: "" } }));
    expect(b.headline).toMatch(/no host connected/i);
  });

  it("names the configured BYO endpoint host", () => {
    const b = describeMode(
      state({ mode: "byo-endpoint", byo: { url: "https://models.internal.acme.com/v1", hasKey: true } })
    );
    expect(b.headline).toContain("models.internal.acme.com");
  });

  it("flags an unconfigured BYO endpoint", () => {
    const b = describeMode(state({ mode: "byo-endpoint" }));
    expect(b.headline).toMatch(/not set/i);
  });
});

describe("measuredHeadline — the '0 bytes out' string is measured, never asserted", () => {
  it("emits '0 bytes out' only when a local model runs AND the monitor reads zero", () => {
    const local = state({ mode: "local", localModelStatus: "running", webgpu: true });
    expect(measuredHeadline(local, true)).toBe("Fully local · 0 bytes out");
    // monitor disagrees -> defer to the plain description
    expect(measuredHeadline(local, false)).toBe("Fully local · on-device model");
  });

  it("never emits '0 bytes out' for a cloud / native-host state, even with a clear monitor", () => {
    const cloudish: AgentModeState[] = [
      state({ host: { kind: "native", name: "ChatGPT" } }),
      state({ mode: "local", localModelStatus: "running", webgpu: true, host: { kind: "native", name: "ChatGPT" } }),
      state({ mode: "cloud", host: { kind: "polyfill-only", name: "" } }),
      state({ mode: "byo-endpoint", byo: { url: "https://x.example/v1", hasKey: true } }),
    ];
    for (const st of cloudish) {
      expect(measuredHeadline(st, true)).not.toMatch(/0 bytes/i);
    }
  });

  it("does not emit '0 bytes out' for a selected-but-not-loaded local model", () => {
    expect(
      measuredHeadline(state({ mode: "local", localModelStatus: "not-downloaded", webgpu: true }), true)
    ).not.toMatch(/0 bytes/i);
  });
});

describe("taglineFor", () => {
  it("uses the strong claim only when an on-device model is driving", () => {
    expect(taglineFor(state({ mode: "local", localModelStatus: "running", webgpu: true }))).toBe(
      "the agent works on data that never leaves your browser"
    );
    expect(taglineFor(state({ mode: "local", localModelStatus: "ready", webgpu: true }))).toBe(
      "the agent works on data that never leaves your browser"
    );
  });

  it("switches to a disclosure line when a native host is attached", () => {
    const t = taglineFor(state({ host: { kind: "native", name: "ChatGPT" } }));
    expect(t).toMatch(/queried slices go to ChatGPT/);
    for (const re of FORBIDDEN) expect(t).not.toMatch(re);
  });

  it("is neutral (no zero-egress claim) when nothing is driving", () => {
    const t = taglineFor(state({ mode: "cloud" }));
    expect(t).not.toMatch(/never leaves your browser/i);
    expect(t).not.toMatch(/0 bytes/i);
  });
});

describe("AgentModeStore", () => {
  it("starts in cloud mode; with no WebGPU the local runtime is 'unavailable'", () => {
    const store = new AgentModeStore();
    expect(store.getState().mode).toBe("cloud");
    expect(store.getState().webgpu).toBe(false);
    expect(store.getState().localModelStatus).toBe("unavailable");
  });

  it("refuses setMode('local') without WebGPU and stays put", () => {
    const store = new AgentModeStore();
    const r = store.setMode("local");
    expect(r.available).toBe(false);
    expect(store.getState().mode).toBe("cloud");
  });

  it("allows switching to byo-endpoint and records the config", () => {
    const store = new AgentModeStore();
    expect(store.setMode("byo-endpoint").available).toBe(true);
    expect(store.getState().mode).toBe("byo-endpoint");
    store.setByoConfig({ url: "https://x.example/v1", hasKey: true });
    expect(store.getState().byo).toEqual({ url: "https://x.example/v1", hasKey: true });
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = new AgentModeStore();
    let hits = 0;
    const off = store.subscribe(() => (hits += 1));
    store.setLocalModelStatus("downloading");
    store.setByoConfig(null);
    expect(hits).toBe(2);
    off();
    store.setLocalModelStatus("not-downloaded");
    expect(hits).toBe(2);
  });

  it("pushes local-model status + active model through from the runtime", () => {
    const store = new AgentModeStore();
    store.setLocalModelStatus("ready", "Qwen2.5-3B-Instruct");
    expect(store.getState().localModelStatus).toBe("ready");
    expect(store.getState().activeModel).toBe("Qwen2.5-3B-Instruct");
  });

  it("picks up WebGPU appearing on a later refreshDetection", () => {
    const store = new AgentModeStore();
    expect(store.getState().webgpu).toBe(false);
    vi.stubGlobal("navigator", { gpu: {} });
    store.refreshDetection();
    expect(store.getState().webgpu).toBe(true);
    expect(store.getState().localModelStatus).toBe("not-downloaded");
    expect(store.setMode("local").available).toBe(true);
  });

  it("drops a selected 'local' mode back to 'cloud' when a native host attaches mid-session", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const store = new AgentModeStore();
    expect(store.setMode("local").available).toBe(true);
    expect(store.getState().mode).toBe("local");

    vi.stubGlobal("window", { __airlockWebMCP: "native" });
    store.refreshDetection();
    expect(store.getState().host.kind).toBe("native");
    expect(store.getState().mode).toBe("cloud");
    expect(store.availability("local").available).toBe(false);
  });

  it("ignores setHostName unless a native host is present", () => {
    const store = new AgentModeStore();
    store.setHostName("ChatGPT");
    expect(store.getState().host.name).toBe("");

    vi.stubGlobal("window", { __airlockWebMCP: "native" });
    store.refreshDetection();
    store.setHostName("ChatGPT");
    expect(store.getState().host.name).toBe("ChatGPT");
    store.setHostName("   ");
    expect(store.getState().host.name).toBe(GENERIC_HOST_NAME);
  });
});
