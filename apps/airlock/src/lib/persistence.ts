/**
 * Airlock session persistence — the whole workspace saved to IndexedDB so a tab
 * reload (or a return visit) restores datasets, filters, derived columns,
 * renames, charts, flags, reports and the activity ledger, under named sessions
 * you can list, switch between and delete.
 *
 * WHY ORIGINAL BYTES, NOT PARQUET/ARROW
 * ------------------------------------
 * We persist the *original source bytes* of every dataset — the CSV/JSON text the
 * user loaded, or the CSV dump of a materialized join — and rebuild the DuckDB
 * table on load by replaying the exact same `registerCsv` / `registerJson` path
 * the first load used (`workspaceStore.hydrate`). Restore is then deterministic
 * *by construction*: same bytes, same importer, same DuckDB build => the same
 * table, with no dependency on a Parquet/Arrow writer extension and no second
 * copy of the data in a lossy intermediate format. The view layer
 * (filters/derived/renames/charts/flags/focus) is small plain JSON layered back
 * on top via `DatasetStore.hydrate`.
 *
 * STORAGE
 * -------
 * IndexedDB only — hand-rolled wrapper below, no `idb` dependency. Zero network:
 * nothing here fetches, so the egress monitor still reads 0. Every failure mode
 * (private window, blocked storage, quota exceeded) degrades to a silent no-op —
 * the app still boots and works, just without persistence, and the Session menu
 * says so.
 *
 * SCHEMA — database "airlock", version 1
 *   sessions  keyPath "id"    { id, name, createdAt, updatedAt,
 *                               workspace: WorkspaceSnapshot,
 *                               reports:  InsightReport[],
 *                               activity: ActivityEntry[] }
 *   blobs     keyPath "key"   { key: `${sessionId}::${tableName}`, sessionId,
 *                               tableName, kind, text? | bytes? }
 *              index "bySession" -> sessionId
 *              (text for csv/json; bytes for the binary format parquet —
 *               IndexedDB stores a Uint8Array natively)
 *   meta      keyPath "k"     { k: "currentSessionId", v: string }
 */

import React from "react";
import { defaultProposalStore } from "webmcp-staged";
import {
  packSource,
  unpackSource,
  workspaceStore,
  type DatasetSnapshot,
  type DatasetSource,
  type DatasetSourceKind,
  type WorkspaceSnapshot,
} from "../engine/workspaceStore";
import { rid } from "../engine/datasetStore";
import { uiStore } from "../engine/uiStore";
import { activityLog, type ActivityEntry } from "../agent/activity";
import { reportStore, type InsightReport } from "../agent/reports";

const DB_NAME = "airlock";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const BLOBS = "blobs";
const META = "meta";
const SAVE_DEBOUNCE_MS = 800;

export interface SessionMeta {
  id: string;
  name: string;
  updatedAt: number;
  datasetCount: number;
}

interface SessionRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  workspace: WorkspaceSnapshot;
  reports: InsightReport[];
  activity: ActivityEntry[];
}

interface BlobRecord {
  key: string;
  sessionId: string;
  tableName: string;
  /** `kind` + (`text` for csv/json | `bytes` for parquet). */
  kind: DatasetSourceKind;
  text?: string;
  bytes?: Uint8Array;
}

export interface PersistenceState {
  /** IndexedDB is present and usable. */
  available: boolean;
  /** Storage is present but a write failed (quota / blocked) — data may be stale. */
  degraded: boolean;
  currentSessionId: string | null;
  sessions: SessionMeta[];
  /** A save / restore / switch is in flight. */
  busy: boolean;
}

// ── observable state (for the Session menu via useSyncExternalStore) ─────────

type Listener = () => void;
const listeners = new Set<Listener>();

let snapshot: PersistenceState = {
  available: hasIndexedDB(),
  degraded: false,
  currentSessionId: null,
  sessions: [],
  busy: false,
};

function setState(patch: Partial<PersistenceState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

export function subscribePersistence(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPersistenceState(): PersistenceState {
  return snapshot;
}

export function usePersistence(): PersistenceState {
  return React.useSyncExternalStore(
    subscribePersistence,
    getPersistenceState,
    getPersistenceState
  );
}

// ── module state ────────────────────────────────────────────────────────────

let currentSessionId: string | null = null;
/** No autosave until boot has decided whether to restore. */
let suspended = true;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Serializes overlapping saves and coalesces requests that arrive mid-write. */
let saveChain: Promise<void> = Promise.resolve();
let saveQueued = false;
let autosaveInstalled = false;
let bootStarted = false;

// ── hand-rolled IndexedDB wrapper ───────────────────────────────────────────

function hasIndexedDB(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    // Some browsers throw on `indexedDB` access in private mode / with storage
    // disabled — treat that as "unavailable".
    return false;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(BLOBS)) {
        const s = db.createObjectStore(BLOBS, { keyPath: "key" });
        s.createIndex("bySession", "sessionId");
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Mark persistence unusable for the rest of this page life. */
function markUnavailable(): void {
  if (snapshot.available) setState({ available: false });
}

// ── low-level session ops ───────────────────────────────────────────────────

async function getSessionRecord(id: string): Promise<SessionRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction(SESSIONS, "readonly");
  return (await reqToPromise(tx.objectStore(SESSIONS).get(id))) as
    | SessionRecord
    | undefined;
}

async function readCurrentSessionId(): Promise<string | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(META, "readonly");
    const rec = (await reqToPromise(tx.objectStore(META).get("currentSessionId"))) as
      | { v?: string }
      | undefined;
    return rec?.v ?? null;
  } catch {
    return null;
  }
}

async function writeCurrentSessionId(id: string | null): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(META, "readwrite");
    if (id) tx.objectStore(META).put({ k: "currentSessionId", v: id });
    else tx.objectStore(META).delete("currentSessionId");
    await txDone(tx);
  } catch {
    /* non-fatal */
  }
}

async function refreshSessions(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(SESSIONS, "readonly");
    const all = (await reqToPromise(tx.objectStore(SESSIONS).getAll())) as SessionRecord[];
    const sessions: SessionMeta[] = all
      .map((r) => ({
        id: r.id,
        name: r.name,
        updatedAt: r.updatedAt,
        datasetCount: r.workspace?.datasets?.length ?? 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    setState({ sessions, available: true });
  } catch {
    markUnavailable();
  }
}

function defaultSessionName(ws: WorkspaceSnapshot): string {
  const first = ws.datasets[0]?.fileName;
  if (!first) return "Untitled session";
  return ws.datasets.length > 1
    ? `${first} +${ws.datasets.length - 1}`
    : first;
}

// ── save ────────────────────────────────────────────────────────────────────

/**
 * Persist the current workspace. Overlapping calls are serialized onto one
 * chain; a call that arrives while a save is running coalesces into a single
 * trailing re-run, so rapid edits can't pile up half-written transactions.
 */
export function saveNow(): Promise<void> {
  if (suspended || !snapshot.available) return Promise.resolve();
  saveQueued = true;
  saveChain = saveChain.then(async () => {
    if (!saveQueued || suspended) return;
    saveQueued = false;
    try {
      await doSave();
    } catch (e) {
      // Keep the chain alive so later saves still run.
      console.warn("[airlock] session save failed:", errText(e));
      setState({ degraded: true });
    }
  });
  return saveChain;
}

async function doSave(): Promise<void> {
  if (suspended || !snapshot.available) return;

  const ws = workspaceStore.serialize();
  // Don't mint an empty session for an untouched workspace.
  if (ws.datasets.length === 0 && !currentSessionId) return;

  if (!currentSessionId) currentSessionId = rid();
  const sessionId = currentSessionId;
  const now = Date.now();

  const blobs: BlobRecord[] = [];
  for (const d of ws.datasets) {
    const src = workspaceStore.getSource(d.id);
    if (!src) continue;
    blobs.push({
      key: `${sessionId}::${d.tableName}`,
      sessionId,
      tableName: d.tableName,
      ...packSource(src),
    });
  }

  try {
    const db = await openDb();
    const existing = await getSessionRecord(sessionId);
    const record: SessionRecord = {
      id: sessionId,
      name: existing?.name ?? defaultSessionName(ws),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      workspace: ws,
      reports: reportStore.list(),
      activity: activityLog.list(),
    };

    // Prune blob keys that no longer belong to this session, in a prior
    // read-only tx so the write tx stays simple.
    const staleKeys = (await reqToPromise(
      db
        .transaction(BLOBS, "readonly")
        .objectStore(BLOBS)
        .index("bySession")
        .getAllKeys(IDBKeyRange.only(sessionId))
    )) as IDBValidKey[];
    const liveKeys = new Set<IDBValidKey>(blobs.map((b) => b.key));

    const tx = db.transaction([SESSIONS, BLOBS], "readwrite");
    tx.objectStore(SESSIONS).put(record);
    const blobStore = tx.objectStore(BLOBS);
    for (const k of staleKeys) if (!liveKeys.has(k)) blobStore.delete(k);
    for (const b of blobs) blobStore.put(b);
    await txDone(tx);

    await writeCurrentSessionId(sessionId);
    setState({ degraded: false, currentSessionId: sessionId });
    await refreshSessions();
  } catch (e) {
    // Quota exceeded / storage blocked mid-session: keep running, flag it.
    setState({ degraded: true });
    console.warn("[airlock] session save failed:", errText(e));
  }
}

function scheduleSave(): void {
  if (suspended || !snapshot.available) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveNow();
  }, SAVE_DEBOUNCE_MS);
}

/** Pause autosave and drop any pending debounced save (for session switch/new/delete). */
function suspendAutosave(): void {
  suspended = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// ── restore ─────────────────────────────────────────────────────────────────

async function restoreSession(id: string): Promise<boolean> {
  const rec = await getSessionRecord(id);
  if (!rec) return false;

  const db = await openDb();
  const blobs = (await reqToPromise(
    db
      .transaction(BLOBS, "readonly")
      .objectStore(BLOBS)
      .index("bySession")
      .getAll(IDBKeyRange.only(id))
  )) as BlobRecord[];
  const byTable = new Map(blobs.map((b) => [b.tableName, b]));

  const datasets = rec.workspace.datasets
    .map((d): (DatasetSnapshot & { payload: DatasetSource }) | null => {
      const b = byTable.get(d.tableName);
      const payload = b ? unpackSource(b) : null;
      return payload ? { ...d, kind: payload.kind, payload } : null;
    })
    .filter(
      (x): x is DatasetSnapshot & { payload: DatasetSource } => x !== null
    );

  await workspaceStore.hydrate(datasets, rec.workspace.activeId);
  reportStore.hydrate(rec.reports ?? []);
  activityLog.hydrate(rec.activity ?? []);

  currentSessionId = id;
  await writeCurrentSessionId(id);
  return (
    datasets.length > 0 ||
    (rec.reports?.length ?? 0) > 0 ||
    (rec.activity?.length ?? 0) > 0
  );
}

/** Tear the live workspace down so a different session can be loaded cleanly. */
async function clearWorkspace(): Promise<void> {
  for (const h of workspaceStore.list()) {
    await workspaceStore.removeDataset(h.id);
  }
  reportStore.hydrate([]);
  activityLog.hydrate([]);
  for (const p of defaultProposalStore.list()) defaultProposalStore.remove(p.id);
}

// ── boot + autosave install (called once, from <SessionMenu>) ────────────────

export async function bootSession(): Promise<void> {
  if (!snapshot.available) {
    suspended = false;
    return;
  }
  try {
    await refreshSessions();
    const id = await readCurrentSessionId();
    if (id) {
      setState({ busy: true });
      uiStore.beginLoad("your last session");
      const ok = await restoreSession(id);
      uiStore.endLoad();
      if (ok) {
        setState({ busy: false, currentSessionId: id });
      } else {
        currentSessionId = null;
        await writeCurrentSessionId(null);
        setState({ busy: false, currentSessionId: null });
      }
    }
  } catch (e) {
    uiStore.endLoad();
    setState({ busy: false, degraded: true });
    console.warn("[airlock] session restore failed:", errText(e));
  } finally {
    suspended = false;
  }
}

export function installAutosave(): void {
  if (autosaveInstalled || !hasIndexedDB()) return;
  autosaveInstalled = true;

  // `activityLog` fires on every tool call (incl. every commit), so subscribing
  // to it, the workspace and the report store together covers every mutation
  // path — human click or agent tool, active dataset or not.
  workspaceStore.subscribe(scheduleSave);
  reportStore.subscribe(scheduleSave);
  activityLog.subscribe(scheduleSave);

  const flush = (): void => {
    if (!suspended && snapshot.available) void saveNow();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
}

// ── Session menu actions ────────────────────────────────────────────────────

export async function newSession(): Promise<void> {
  await saveNow(); // keep whatever is currently loaded
  suspendAutosave();
  try {
    await clearWorkspace();
    currentSessionId = null;
    await writeCurrentSessionId(null);
    setState({ currentSessionId: null });
    await refreshSessions();
  } finally {
    suspended = false;
  }
}

export async function switchSession(id: string): Promise<void> {
  if (id === currentSessionId || snapshot.busy) return;
  await saveNow();
  suspendAutosave();
  setState({ busy: true });
  uiStore.beginLoad("session");
  try {
    await clearWorkspace();
    await restoreSession(id);
    setState({ currentSessionId: id });
  } catch (e) {
    setState({ degraded: true });
    console.warn("[airlock] session switch failed:", errText(e));
  } finally {
    uiStore.endLoad();
    setState({ busy: false });
    suspended = false;
    await refreshSessions();
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    const db = await openDb();
    const keys = (await reqToPromise(
      db
        .transaction(BLOBS, "readonly")
        .objectStore(BLOBS)
        .index("bySession")
        .getAllKeys(IDBKeyRange.only(id))
    )) as IDBValidKey[];
    const tx = db.transaction([SESSIONS, BLOBS], "readwrite");
    tx.objectStore(SESSIONS).delete(id);
    for (const k of keys) tx.objectStore(BLOBS).delete(k);
    await txDone(tx);
  } catch (e) {
    console.warn("[airlock] session delete failed:", errText(e));
  }

  if (id === currentSessionId) {
    suspendAutosave();
    await clearWorkspace();
    currentSessionId = null;
    await writeCurrentSessionId(null);
    setState({ currentSessionId: null });
    suspended = false;
  }
  await refreshSessions();
}

export async function renameSession(id: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  try {
    const rec = await getSessionRecord(id);
    if (!rec) return;
    const db = await openDb();
    const tx = db.transaction(SESSIONS, "readwrite");
    tx.objectStore(SESSIONS).put({ ...rec, name: clean });
    await txDone(tx);
  } catch (e) {
    console.warn("[airlock] session rename failed:", errText(e));
  }
  await refreshSessions();
}

// ── React boot hook ─────────────────────────────────────────────────────────

/**
 * Run `bootSession()` + `installAutosave()` exactly once for the app lifetime.
 * Rendering is never blocked on it — the workspace stores drive re-renders as
 * datasets come back, and the existing LoadingIndicator (via `uiStore`) covers
 * the restore.
 */
export function useSessionBoot(): void {
  React.useEffect(() => {
    if (bootStarted) return;
    bootStarted = true;
    void bootSession().then(installAutosave);
  }, []);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
