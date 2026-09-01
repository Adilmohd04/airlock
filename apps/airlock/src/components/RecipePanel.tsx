/**
 * Recipe bar — sits under the tab strip. Export the current view's transforms as
 * a `.json` recipe; import one captured earlier and replay it.
 *
 * Replay never mutates: it stages every step as a pending proposal in the review
 * queue on the right, where the human approves them one by one (see
 * `lib/recipes.ts`). Steps that reference a column this dataset lacks are listed
 * as skipped, with the reason.
 */

import { useRef, useState } from "react";
import { useActiveDataset } from "../engine/useDataset";
import {
  describeStep,
  downloadRecipe,
  parseRecipe,
  planReplay,
  replayRecipe,
  serializeRecipe,
  type Recipe,
  type ReplayOutcome,
} from "../lib/recipes";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RecipePanel() {
  const { store, state } = useActiveDataset();
  const [open, setOpen] = useState(false);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [outcome, setOutcome] = useState<ReplayOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!state?.loaded || !store) return null;

  const transformCount =
    state.filters.length +
    state.derived.length +
    Object.keys(state.renames).length +
    state.flags.length +
    state.charts.length;

  const plan = recipe ? planReplay(recipe, state) : null;

  const onExport = () => {
    setError(null);
    try {
      downloadRecipe(serializeRecipe(state));
    } catch (e) {
      setError(msg(e));
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setOutcome(null);
    try {
      setRecipe(parseRecipe(await file.text()));
      setOpen(true);
    } catch (e) {
      setRecipe(null);
      setError(msg(e));
    }
  };

  const onReplay = async () => {
    if (!recipe) return;
    setBusy(true);
    setError(null);
    try {
      setOutcome(await replayRecipe(recipe, store));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    setRecipe(null);
    setOutcome(null);
    setError(null);
  };

  return (
    <div className="shrink-0 border-b border-ink-800 bg-ink-900">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <button
          className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="w-2 text-slate-600">{open ? "▾" : "▸"}</span>
          <span className="panel-title !text-slate-400">Recipe</span>
        </button>

        {recipe && (
          <span className="chip !py-0.5 !text-[10px]">
            {recipe.name}
            <span className="text-slate-600">· {recipe.steps.length} steps</span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="btn btn-ghost !px-2 !py-0.5 text-[11px]"
            onClick={onExport}
            disabled={transformCount === 0}
            title={
              transformCount === 0
                ? "Apply a filter, derived column, rename, flag or chart first"
                : "Download this view's transforms as a .json recipe"
            }
          >
            Export
          </button>
          <button
            className="btn btn-ghost !px-2 !py-0.5 text-[11px]"
            onClick={() => fileRef.current?.click()}
          >
            Import
          </button>
          {recipe && (
            <>
              <button
                className="btn btn-primary !px-2 !py-0.5 text-[11px]"
                onClick={onReplay}
                disabled={busy || !plan || plan.applicable.length === 0}
                title="Stage every replayable step as a proposal for you to approve"
              >
                {busy
                  ? "Staging…"
                  : `Replay → review (${plan?.applicable.length ?? 0})`}
              </button>
              <button
                className="px-1 text-slate-600 hover:text-danger"
                title="Unload recipe"
                onClick={clear}
              >
                ✕
              </button>
            </>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            void onPickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {error && <p className="px-3 pb-1.5 text-[11px] text-danger">{error}</p>}

      {open && recipe && (
        <div className="space-y-2 border-t border-ink-800 bg-ink-950 px-3 py-2 text-[11px]">
          <p className="text-slate-600">
            Captured from{" "}
            <span className="font-mono text-slate-400">{recipe.source.fileName}</span>{" "}
            · {recipe.source.columns.length} columns ·{" "}
            {new Date(recipe.createdAt).toLocaleDateString()}
          </p>

          <ol className="space-y-0.5 font-mono text-slate-400">
            {recipe.steps.map((step, i) => {
              const skip = plan?.skipped.find((s) => s.index === i);
              return (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-slate-600">{i + 1}.</span>
                  <span className={skip ? "text-slate-600" : ""}>
                    {describeStep(step)}
                  </span>
                  {skip && (
                    <span className="text-pending">— will skip: {skip.reason}</span>
                  )}
                </li>
              );
            })}
          </ol>

          {plan && plan.skipped.length > 0 && !outcome && (
            <p className="text-pending">
              {plan.skipped.length} step(s) won't replay on this dataset (see
              above); the rest stage as proposals.
            </p>
          )}

          {outcome && (
            <div className="space-y-1 border-t border-ink-800 pt-2">
              <p className="text-commit">
                Staged {outcome.staged} proposal(s) — approve them in the review
                queue.
              </p>
              {outcome.skipped.length > 0 && (
                <div className="text-pending">
                  <p>Skipped {outcome.skipped.length} step(s):</p>
                  <ul className="ml-3 list-disc text-slate-500">
                    {outcome.skipped.map((s) => (
                      <li key={s.index}>
                        {describeStep(s.step)} — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
