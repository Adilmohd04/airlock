/**
 * Late host attach — pins the classification and the exactly-once transition.
 *
 * Vitest runs in node (no DOM), so the transition tests install minimal fake
 * `document`/`window` globals and remove them afterwards. The fakes only need
 * the shapes `hostAttach` actually reads: `document.modelContext` and a
 * mutable `window` for the bootstrap flag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  classifyHost,
  recheckHostAttach,
  onHostAttach,
  removeNonFunctionalStub,
  scheduleLateRechecks,
  watchForNativeHost,
  LATE_RECHECK_DELAYS,
  NATIVE_HOST_POLL_MS,
  __resetHostAttachForTests,
} from "../hostAttach";
import { agentModeStore } from "../agentMode";

type Globals = {
  document?: {
    modelContext?: unknown;
    visibilityState?: string;
    addEventListener?: (...args: unknown[]) => void;
    removeEventListener?: (...args: unknown[]) => void;
  };
  window?: { __airlockWebMCP?: string };
};

function globals(): Globals {
  return globalThis as unknown as Globals;
}

const nativeInstance = () => ({ registerTool: () => undefined });
const polyfillInstance = () => ({
  registerTool: () => undefined,
  __isWebMCPPolyfill: true,
});

describe("classifyHost", () => {
  it("is absent for missing or tool-less values", () => {
    expect(classifyHost(undefined)).toBe("absent");
    expect(classifyHost(null)).toBe("absent");
    expect(classifyHost({})).toBe("absent");
    expect(classifyHost({ registerTool: "not-a-function" })).toBe("absent");
  });

  it("is polyfill for the marked testing instance", () => {
    expect(classifyHost(polyfillInstance())).toBe("polyfill");
  });

  it("is native for a real host-shaped instance", () => {
    expect(classifyHost(nativeInstance())).toBe("native");
  });
});

describe("recheckHostAttach", () => {
  let savedDocument: unknown;
  let savedWindow: unknown;

  beforeEach(() => {
    savedDocument = globals().document;
    savedWindow = globals().window;
    delete globals().document;
    delete globals().window;
    __resetHostAttachForTests();
  });

  afterEach(() => {
    if (savedDocument === undefined) delete globals().document;
    else globals().document = savedDocument as Globals["document"];
    if (savedWindow === undefined) delete globals().window;
    else globals().window = savedWindow as Globals["window"];
    __resetHostAttachForTests();
  });

  it("no-ops without a document", () => {
    expect(recheckHostAttach()).toBe(false);
  });

  it("fires exactly once on a polyfill -> native transition", () => {
    const poly = polyfillInstance();
    const nat = nativeInstance();
    globals().document = { modelContext: poly, visibilityState: "visible" };
    globals().window = {};

    let calls = 0;
    const off = onHostAttach(() => {
      calls += 1;
    });
    try {
      // First call only snapshots the baseline — no transition yet.
      expect(recheckHostAttach()).toBe(false);
      expect(calls).toBe(0);

      globals().document!.modelContext = nat;
      expect(recheckHostAttach()).toBe(true);
      expect(calls).toBe(1);
      expect(globals().window!.__airlockWebMCP).toBe("native");
      expect(agentModeStore.getState().host.kind).toBe("native");

      // Same instance again: no churn, no second notification.
      expect(recheckHostAttach()).toBe(false);
      expect(calls).toBe(1);
    } finally {
      off();
    }
  });

  it("stays silent when a native host was there from the start", () => {
    globals().document = {
      modelContext: nativeInstance(),
      visibilityState: "visible",
    };
    globals().window = {};
    expect(recheckHostAttach()).toBe(false);
  });

  it("stays silent while the polyfill has nobody driving", () => {
    globals().document = {
      modelContext: polyfillInstance(),
      visibilityState: "visible",
    };
    globals().window = {};
    expect(recheckHostAttach()).toBe(false);
    expect(recheckHostAttach()).toBe(false);
  });
});

describe("scheduleLateRechecks", () => {  it("re-checks on each beat and stops after cleanup", () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const off = scheduleLateRechecks(() => {
        calls += 1;
      });
      expect(calls).toBe(0);
      vi.advanceTimersByTime(LATE_RECHECK_DELAYS[0]);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(
        LATE_RECHECK_DELAYS[1] - LATE_RECHECK_DELAYS[0]
      );
      expect(calls).toBe(2);
      off();
      vi.advanceTimersByTime(60_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchForNativeHost", () => {
  let savedDocument: unknown;
  let savedWindow: unknown;

  function fakeWindow() {
    return {
      __airlockWebMCP: undefined as string | undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }

  beforeEach(() => {
    savedDocument = globals().document;
    savedWindow = globals().window;
    delete globals().document;
    delete globals().window;
    __resetHostAttachForTests();
  });

  afterEach(() => {
    if (savedDocument === undefined) delete globals().document;
    else globals().document = savedDocument as Globals["document"];
    if (savedWindow === undefined) delete globals().window;
    else globals().window = savedWindow as Globals["window"];
    __resetHostAttachForTests();
    vi.useRealTimers();
  });

  it("polls until a late native host appears, then stops", () => {
    vi.useFakeTimers();
    const nat = nativeInstance();
    const noopEvents = () => undefined;
    globals().document = {
      modelContext: polyfillInstance(),
      visibilityState: "visible",
      addEventListener: noopEvents,
      removeEventListener: noopEvents,
    };
    globals().window = fakeWindow();

    let calls = 0;
    const offAttach = onHostAttach(() => {
      calls += 1;
    });
    const offWatch = watchForNativeHost();
    try {
      // Beats of polling with no host: silent.
      vi.advanceTimersByTime(NATIVE_HOST_POLL_MS * 3);
      expect(calls).toBe(0);

      // Host arrives late (long after any scheduled beat would run).
      vi.advanceTimersByTime(10 * 60_000);
      globals().document!.modelContext = nat;
      vi.advanceTimersByTime(NATIVE_HOST_POLL_MS);
      expect(calls).toBe(1);

      // Poll cleared itself: no repeat notifications.
      vi.advanceTimersByTime(10 * 60_000);
      expect(calls).toBe(1);
    } finally {
      offAttach();
      offWatch();
    }
  });

  it("unsubscribing stops the poll", () => {
    vi.useFakeTimers();
    const noopEvents = () => undefined;
    globals().document = {
      modelContext: polyfillInstance(),
      visibilityState: "visible",
      addEventListener: noopEvents,
      removeEventListener: noopEvents,
    };
    globals().window = fakeWindow();

    let calls = 0;
    const offAttach = onHostAttach(() => {
      calls += 1;
    });
    const offWatch = watchForNativeHost();
    offWatch();
    globals().document!.modelContext = nativeInstance();
    vi.advanceTimersByTime(10 * 60_000);
    expect(calls).toBe(0);
    offAttach();
  });
});

describe("removeNonFunctionalStub", () => {
  let savedDocument: unknown;

  beforeEach(() => {
    savedDocument = globals().document;
    delete globals().document;
    __resetHostAttachForTests();
  });

  afterEach(() => {
    if (savedDocument === undefined) delete globals().document;
    else globals().document = savedDocument as Globals["document"];
    __resetHostAttachForTests();
  });

  it("no-ops without a document", () => {
    expect(removeNonFunctionalStub()).toBe(false);
  });

  it("removes a registerTool-less stub", () => {
    globals().document = {
      modelContext: { someField: 1 },
      visibilityState: "visible",
    };
    expect(removeNonFunctionalStub()).toBe(true);
    expect(globals().document!.modelContext).toBe(undefined);
  });

  it("keeps functional and polyfill instances", () => {
    globals().document = {
      modelContext: nativeInstance(),
      visibilityState: "visible",
    };
    expect(removeNonFunctionalStub()).toBe(false);
    expect(globals().document!.modelContext).toBeDefined();

    globals().document = {
      modelContext: polyfillInstance(),
      visibilityState: "visible",
    };
    expect(removeNonFunctionalStub()).toBe(false);
    expect(globals().document!.modelContext).toBeDefined();
  });
});
