/**
 * ModelDownloadDialog — the single, unmissable consent + progress surface for
 * getting an on-device model. It is the first thing a first-time user meets
 * when they choose to run the agent locally, so the copy is plain and the
 * claims are ones the egress monitor can back:
 *
 *  - the download is served from THIS origin (same place as the app), so the
 *    egress monitor counts it under "same-origin asset loads", never as an
 *    external request or a sent byte — the Seal's "0 bytes out" holds through it;
 *  - it carries only model weights — no dataset, no column value, no question;
 *  - after it is cached, the model runs on the user's GPU and the agent's reads
 *    never leave the tab.
 *
 * State + all model logic come from `localModelStore` (stubbed on this branch —
 * see `LocalModelPanel.tsx`). This file is presentation only.
 */

import { useEffect, useRef } from "react";
import { uiStore, useUI } from "../engine/uiStore";
import {
  CloudFallbackNote,
  HardwareLine,
  ModelChooser,
  ModelProgressBar,
  formatModelSize,
  getModel,
  localModelStore,
  useLocalModelStore,
} from "./LocalModelPanel";

const TITLE_ID = "local-model-dialog-title";

export function ModelDownloadDialog() {
  const ui = useUI();
  const s = useLocalModelStore();
  const open = ui.localModel.dialogOpen;
  const cardRef = useRef<HTMLDivElement>(null);

  const close = () => uiStore.closeLocalModelDialog();

  // Modal behaviour: focus in on open, restore on close, trap Tab, Escape closes.
  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        card?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const model = getModel(s.selectedModelId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="w-full max-w-lg animate-slide-in rounded-xl border border-ink-700 bg-ink-900 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-800 px-5 py-3">
          <h2 id={TITLE_ID} className="text-sm font-semibold text-white">
            Run the agent on your device
          </h2>
          <button
            type="button"
            onClick={close}
            className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
              <path d="M4.3 3.3 8 7l3.7-3.7 1 1L10 8l3.7 3.7-1 1L8 9l-3.7 3.7-1-1L6 8 2.3 4.3l1-1Z" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 text-xs">
          {s.status === "unavailable" && <UnavailableBody reason={s.unavailableReason} />}
          {s.status === "not-downloaded" && <ConsentBody />}
          {s.status === "downloading" && <DownloadingBody />}
          {s.status === "paused" && <PausedBody />}
          {s.status === "error" && <ErrorBody error={s.error} />}
          {s.status === "ready" && <ReadyBody />}
          {s.status === "running" && <RunningBody />}
        </div>
      </div>
    </div>
  );

  // ── bodies ────────────────────────────────────────────────────────────────

  function UnavailableBody({ reason }: { reason: string | null }) {
    return (
      <div className="space-y-3">
        <p className="leading-relaxed text-slate-300">
          {reason ?? "A model can't run on this browser."}
        </p>
        {s.hardware?.adapter && (
          <p className="text-slate-500">
            Detected GPU:{" "}
            <span className="font-mono text-slate-300">{s.hardware.adapter}</span>
          </p>
        )}
        <CloudFallbackNote />
        <div className="flex justify-end pt-1">
          <button type="button" className="btn btn-ghost text-xs" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }

  function ConsentBody() {
    return (
      <div className="space-y-3">
        <p className="leading-relaxed text-slate-300">
          Airlock will download <span className="font-medium text-white">{model.label}</span>{" "}
          — about{" "}
          <span className="font-mono text-white">
            {formatModelSize(model.downloadBytes)}
          </span>{" "}
          — once. It is the model's weights and nothing else: none of your data,
          your file, or your questions are part of it.
        </p>
        <p className="leading-relaxed text-slate-300">
          The download is served from this site — the same origin as the app —
          so the egress monitor counts it as an asset load, not external traffic.
          The Seal's <span className="font-mono">0 bytes out</span> holds
          throughout.
        </p>
        <p className="leading-relaxed text-slate-300">
          After it is cached in this browser, it runs on your GPU — no further
          download, and it works with the network off. Whenever the agent runs
          in Local mode, everything it reads stays on this device: not the file,
          not a value, not your questions.
        </p>
        <p className="leading-relaxed text-slate-500">
          Airlock asks your browser to keep this cache durably. If it hasn&rsquo;t
          granted that,{" "}
          <span className="text-slate-400">
            bookmark this page or install it as an app
          </span>{" "}
          so the weights survive a storage cleanup instead of re-downloading.
        </p>

        <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
          <p className="panel-title mb-1">Hardware</p>
          <HardwareLine hardware={s.hardware} />
        </div>

        <details className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
          <summary className="cursor-pointer select-none font-medium text-slate-300">
            Choose a different model
          </summary>
          <p className="mt-1 mb-2 text-[11px] text-slate-500">
            The default is the most reliable at tool-calling. Pick a smaller one
            for a weaker GPU or a faster download.
          </p>
          <ModelChooser state={s} onSelect={(id) => localModelStore.selectModel(id)} />
        </details>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className="btn btn-primary text-xs"
            disabled={s.hardware != null && !s.hardware.available}
            onClick={() => void localModelStore.download()}
          >
            Download &amp; run locally
          </button>
          <button type="button" className="btn btn-ghost text-xs" onClick={close}>
            Not now
          </button>
        </div>
        <p className="text-[10px] leading-relaxed text-slate-600">
          One-time download. You can delete the weights later from the Local
          model panel to reclaim the space.
        </p>
      </div>
    );
  }

  function DownloadingBody() {
    if (!s.progress) return null;
    return (
      <div className="space-y-3">
        <p className="font-medium text-slate-200">Downloading {model.label}</p>
        <ModelProgressBar progress={s.progress} />
        <p className="leading-relaxed text-slate-500">
          Keep this tab open. You can close this dialog — the download continues
          and its progress shows on the Local model button. Cancelling keeps
          what has already downloaded, so you can resume later without
          re-fetching it.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn btn-ghost text-xs"
            onClick={() => localModelStore.cancelDownload()}
          >
            Cancel download
          </button>
          <button type="button" className="btn btn-ghost text-xs" onClick={close}>
            Close (keep downloading)
          </button>
        </div>
      </div>
    );
  }

  function PausedBody() {
    return (
      <div className="space-y-3">
        <p className="font-medium text-slate-200">Download paused</p>
        <p className="leading-relaxed text-slate-300">
          <span className="font-mono">{formatModelSize(s.partialBytes)}</span> of{" "}
          <span className="font-mono">{formatModelSize(model.downloadBytes)}</span>{" "}
          is saved in this browser's cache. Resuming continues from where it
          stopped — nothing already fetched is fetched again.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn btn-primary text-xs"
            onClick={() => void localModelStore.download()}
          >
            Resume download
          </button>
          <button
            type="button"
            className="btn btn-reject text-xs"
            onClick={async () => {
              await localModelStore.deleteWeights(s.selectedModelId);
              close();
            }}
          >
            Discard &amp; close
          </button>
        </div>
      </div>
    );
  }

  function ErrorBody({ error }: { error: string | null }) {
    return (
      <div className="space-y-3">
        <p className="font-medium text-danger">Download didn't finish</p>
        <p className="leading-relaxed text-slate-300">
          {error ?? "The download stopped before it completed."}
        </p>
        <p className="leading-relaxed text-slate-500">
          Anything already downloaded is kept, so retrying resumes rather than
          starting over.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn btn-primary text-xs"
            onClick={() => {
              localModelStore.clearError();
              void localModelStore.download();
            }}
          >
            Try again
          </button>
          <button type="button" className="btn btn-ghost text-xs" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }

  function ReadyBody() {
    return (
      <div className="space-y-3">
        <p className="font-medium text-airlock-300">Local model ready</p>
        <p className="leading-relaxed text-slate-300">
          {model.label} is cached in this browser. From now on it loads without a
          download — including with the network off.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn btn-primary text-xs"
            onClick={() => void localModelStore.load()}
          >
            Load model now
          </button>
          <button type="button" className="btn btn-ghost text-xs" onClick={close}>
            Close
          </button>
        </div>
      </div>
    );
  }

  function RunningBody() {
    return (
      <div className="space-y-3">
        <p className="font-medium text-airlock-300">Loaded on your device</p>
        <p className="leading-relaxed text-slate-300">
          {getModel(s.activeModelId ?? s.selectedModelId).label} is resident on
          your GPU. In Local mode the agent runs on it here, and everything it
          reads stays on this device.
        </p>
        <div className="flex justify-end pt-1">
          <button type="button" className="btn btn-primary text-xs" onClick={close}>
            Done
          </button>
        </div>
      </div>
    );
  }
}
