/**
 * Egress monitor — the technical backing for Airlock's core claim.
 *
 * We wrap `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, and `WebSocket` and
 * count every byte the page tries to send to the network, plus the hosts it
 * contacts. Same-origin GETs for our own static assets (the app bundle, the
 * DuckDB `.wasm`, the demo CSV) are expected and shown separately; anything
 * else — any cross-origin request, any request with a body — is what the seal
 * is about.
 *
 * Install this as the very first thing in `main.tsx`, before any other module
 * can hold a reference to the original `fetch`.
 */

export interface EgressState {
  /** Cross-origin or body-bearing requests since the monitor started. */
  externalRequests: number;
  /** Total request-body bytes sent to any destination. */
  bytesSent: number;
  /** Distinct external hosts contacted. */
  hosts: string[];
  /** Same-origin asset GETs (expected: app chunks, wasm, demo data). */
  assetRequests: number;
  /** True once the initial page load settled — after this, 0 is the promise. */
  sealed: boolean;
}

type Listener = () => void;

const state: EgressState = {
  externalRequests: 0,
  bytesSent: 0,
  hosts: [],
  assetRequests: 0,
  sealed: false,
};
const listeners = new Set<Listener>();

// A referentially-stable snapshot for useSyncExternalStore — only replaced when
// something actually changes.
let snapshot: EgressState = { ...state, hosts: [] };

function emit(): void {
  snapshot = { ...state, hosts: [...state.hosts] };
  for (const l of listeners) l();
}

export function subscribeEgress(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getEgress(): EgressState {
  return snapshot;
}

function bodySize(body: unknown): number {
  if (!body) return 0;
  try {
    if (typeof body === "string") return new Blob([body]).size;
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return (body as ArrayBufferView).byteLength;
    if (body instanceof URLSearchParams) return new Blob([body.toString()]).size;
    if (body instanceof FormData) return -1; // unknown, but non-zero
  } catch {
    /* ignore */
  }
  return 0;
}

export function record(rawUrl: string, sentBytes: number, hasBody: boolean): void {
  let host = "";
  try {
    host = new URL(rawUrl, location.href).host;
  } catch {
    host = rawUrl;
  }
  const before = JSON.stringify(state);
  const sameOrigin = host === location.host;
  if (sameOrigin && !hasBody) {
    state.assetRequests += 1;
  } else {
    state.externalRequests += 1;
    if (host && !state.hosts.includes(host)) state.hosts.push(host);
  }
  if (sentBytes > 0) state.bytesSent += sentBytes;
  if (JSON.stringify(state) !== before) emit();
}

export function installEgressMonitor(): void {
  if (typeof window === "undefined") return;

  const origFetch = window.fetch;
  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body = init?.body ?? (input instanceof Request ? undefined : undefined);
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    record(url, bodySize(body), !!body || (method !== "GET" && method !== "HEAD"));
    return origFetch.call(this, input as RequestInfo, init);
  };

  const OrigXHR = window.XMLHttpRequest;
  class PatchedXHR extends OrigXHR {
    private _url = "";
    private _method = "GET";
    open(method: string, url: string | URL, ...rest: unknown[]): void {
      this._method = method.toUpperCase();
      this._url = typeof url === "string" ? url : url.href;
      // @ts-expect-error - passthrough
      return super.open(method, url, ...rest);
    }
    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      record(
        this._url,
        bodySize(body),
        !!body || (this._method !== "GET" && this._method !== "HEAD")
      );
      return super.send(body as XMLHttpRequestBodyInit | null | undefined);
    }
  }
  window.XMLHttpRequest = PatchedXHR as unknown as typeof XMLHttpRequest;

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      record(typeof url === "string" ? url : url.href, bodySize(data), true);
      return origBeacon(url, data);
    };
  }

  const OrigWS = window.WebSocket;
  if (OrigWS) {
    window.WebSocket = new Proxy(OrigWS, {
      construct(target, args: [string | URL, (string | string[])?]) {
        record(String(args[0]), 0, true);
        return Reflect.construct(target, args);
      },
    });
  }

  // Mark the page "sealed" once the load has clearly settled.
  const seal = () => {
    state.sealed = true;
    emit();
  };
  if (document.readyState === "complete") {
    setTimeout(seal, 1500);
  } else {
    window.addEventListener("load", () => setTimeout(seal, 1500), { once: true });
  }
}
