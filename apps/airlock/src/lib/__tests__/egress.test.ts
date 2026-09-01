/**
 * Egress-classifier trust-boundary test suite
 * (submission-hardening, Requirements 7.4, 7.5).
 *
 * These tests pin the ACTUAL classification behavior of `record()` in
 * `../egress` — the single function every fetch/XHR/beacon/WebSocket wrapper
 * funnels into. `record(rawUrl, sentBytes, hasBody)` resolves `rawUrl` against
 * `location.href`, extracts the host, and:
 *   - same-origin (`host === location.host`) AND no body → `assetRequests += 1`
 *   - otherwise (cross-origin OR body-bearing) → `externalRequests += 1` and the
 *     host is recorded in `hosts` (deduped, only when non-empty).
 *
 * `record` is module-private in production but is exported (a single additive
 * `export`, no logic change) so the classifier can be driven directly — the
 * cleanest way to prove Property 10 without patching global `fetch`.
 *
 * ENVIRONMENT: the Vitest config uses `environment: 'node'`, where there is no
 * DOM `location`. `record` reads global `location` (via `location.href` /
 * `location.host`), so we install a minimal fixed-origin `globalThis.location`
 * stub for the suite. This is confined to this test file.
 *
 * OBSERVATION MODEL: `record` mutates a module-level `state` and publishes an
 * updated snapshot via `getEgress()` only when the state actually changes. Every
 * classified request advances at least one counter, so each call updates the
 * snapshot. We therefore observe classification by diffing `getEgress()`
 * before/after each call rather than reaching into module internals.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { record, getEgress, type EgressState } from "../egress";

const RUNS = { numRuns: 100 } as const;

// The fixed origin the classifier compares against for the whole suite.
const ORIGIN_PROTOCOL = "https:";
const ORIGIN_HOST = "app.example";
const ORIGIN_HREF = `${ORIGIN_PROTOCOL}//${ORIGIN_HOST}/`;

let savedLocation: PropertyDescriptor | undefined;

beforeAll(() => {
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  // Minimal stub: `record` only reads `.href` (to resolve relative URLs) and
  // `.host` (for the same-origin comparison).
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: ORIGIN_HREF, host: ORIGIN_HOST },
  });
});

afterAll(() => {
  if (savedLocation) {
    Object.defineProperty(globalThis, "location", savedLocation);
  } else {
    // @ts-expect-error - remove the stub we added
    delete globalThis.location;
  }
});

/** Snapshot the current cumulative egress counters. */
function snap(): EgressState {
  return getEgress();
}

/**
 * Drive one classification and return the deltas plus whether the resolved host
 * became newly present in the recorded `hosts` list.
 */
function classify(url: string, bytes: number, hasBody: boolean) {
  const before = snap();
  const hostsBefore = new Set(before.hosts);
  record(url, bytes, hasBody);
  const after = snap();

  const resolvedHost = (() => {
    try {
      return new URL(url, ORIGIN_HREF).host;
    } catch {
      return url;
    }
  })();

  return {
    dAsset: after.assetRequests - before.assetRequests,
    dExternal: after.externalRequests - before.externalRequests,
    dBytes: after.bytesSent - before.bytesSent,
    resolvedHost,
    hostNewlyRecorded:
      !hostsBefore.has(resolvedHost) && after.hosts.includes(resolvedHost),
    hostPresentAfter: after.hosts.includes(resolvedHost),
  };
}

// ---------------------------------------------------------------------------
// Property 10 (R7.5, R7.4): same-origin no-body GET → assetRequests;
// every other case (cross-origin OR body-bearing) → externalRequests + host
// ---------------------------------------------------------------------------
describe("Property 10 — egress monitor classifies requests correctly", () => {
  // Feature: submission-hardening, Property 10: a same-origin, no-body request
  // increments assetRequests (never externalRequests); any cross-origin OR
  // body-bearing request increments externalRequests and records the host.
  it("classifies a fast-check mix of same/cross-origin and with/without body (property)", () => {
    // Same-origin URL shapes: absolute-same-host and origin-relative paths — the
    // shapes real static assets and code-split chunks take.
    const sameOriginUrl = fc.oneof(
      fc
        .stringMatching(/^[a-z0-9/_.-]{0,40}$/)
        .map((p) => `/assets/${p.replace(/^\/+/, "")}`),
      fc.constantFrom(
        "/",
        "/index.html",
        "/assets/index-abc123.js",
        "/assets/duckdb-eh-worker-9f3a.js",
        "/demo/compensation.csv",
        `${ORIGIN_HREF}assets/vendor-react-1a2b.js`,
        `https://${ORIGIN_HOST}/assets/recharts-77.js`
      )
    );

    // Cross-origin URLs: a different host is the sole reason to be "external".
    const crossOriginUrl = fc
      .constantFrom(
        "https://cdn.jsdelivr.net/npm/x.js",
        "https://evil.example/collect",
        "http://analytics.test/beacon",
        "https://fonts.googleapis.com/css",
        "https://api.other.example/v1/data"
      );

    fc.assert(
      fc.property(
        fc.boolean(), // sameOrigin?
        fc.boolean(), // hasBody?
        fc.nat({ max: 4096 }), // sentBytes
        sameOriginUrl,
        crossOriginUrl,
        (sameOrigin, hasBody, bytes, sUrl, xUrl) => {
          const url = sameOrigin ? sUrl : xUrl;
          const r = classify(url, bytes, hasBody);

          const expectedAsset = sameOrigin && !hasBody;

          if (expectedAsset) {
            // Same-origin + no body → asset load, and NEVER external.
            expect(r.dAsset).toBe(1);
            expect(r.dExternal).toBe(0);
          } else {
            // Cross-origin OR body-bearing → external, host recorded, not asset.
            expect(r.dExternal).toBe(1);
            expect(r.dAsset).toBe(0);
            // The host is present in the recorded hosts after the call (it may
            // already have been recorded by an earlier iteration; dedupe means
            // it is present either way, and newly recorded the first time).
            if (r.resolvedHost) {
              expect(r.hostPresentAfter).toBe(true);
            }
          }

          // bytesSent only ever grows by the positive byte count supplied.
          expect(r.dBytes).toBe(bytes > 0 ? bytes : 0);
        }
      ),
      RUNS
    );
  });

  // Feature: submission-hardening, Property 10 (R7.5 link): a dynamically
  // imported same-origin code-split chunk is a same-origin, no-body GET, so it
  // is classified as an ASSET load — not an external request. This is the exact
  // shape Vite emits for `await import(...)` chunks served from our own origin.
  it("classifies a same-origin no-body GET code-split chunk as an asset load, not external (R7.5)", () => {
    const chunkUrl = "/assets/duckdb-browser-eh-3f9c2a.js";
    const r = classify(chunkUrl, 0, /* hasBody */ false);
    expect(r.dAsset).toBe(1);
    expect(r.dExternal).toBe(0);
    expect(r.dBytes).toBe(0);
  });

  it("increments externalRequests and records the host for a cross-origin GET (example)", () => {
    const before = snap();
    const r = classify("https://cdn.jsdelivr.net/npm/pkg/dist/x.js", 0, false);
    expect(r.dExternal).toBe(1);
    expect(r.dAsset).toBe(0);
    expect(getEgress().hosts).toContain("cdn.jsdelivr.net");
    // Sanity: external count strictly grew.
    expect(getEgress().externalRequests).toBe(before.externalRequests + 1);
  });

  it("increments externalRequests for a same-origin request that carries a body (example)", () => {
    // Same host, but a POST-shaped body makes it external per the classifier.
    const r = classify(`${ORIGIN_HREF}assets/upload`, 128, /* hasBody */ true);
    expect(r.dExternal).toBe(1);
    expect(r.dAsset).toBe(0);
    expect(r.dBytes).toBe(128);
  });

  it("records a distinct cross-origin host only once (dedupe, example)", () => {
    classify("https://dupe.example/a.js", 0, false);
    const afterFirst = getEgress().hosts.filter((h) => h === "dupe.example").length;
    classify("https://dupe.example/b.js", 0, false);
    const afterSecond = getEgress().hosts.filter((h) => h === "dupe.example").length;
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });
});
