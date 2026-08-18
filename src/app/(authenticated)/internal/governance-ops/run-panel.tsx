"use client";

// Phase 18F-C — the two trigger buttons and their outcome.
//
// A client component for ONE reason: the run's counts and its bounded failure reason are not persisted anywhere, so a
// revalidated server render has nothing to show them from. `useActionState` holds the outcome for the operator who
// caused it, which is exactly as long as it needs to exist while every run is attended.
//
// It renders only what the server action returned — a boolean, reviewed copy, integer counts and reviewed notes. It
// re-derives nothing and decides nothing, and there is no path here that could reach a raw error, an id or a token.

import { useActionState } from "react";
import { runEvaluationAction, runMatcherAction, type OpsActionState } from "./actions";

function Outcome({ state }: { state: OpsActionState }) {
  if (!state) return null;
  return (
    <div role="status" className="space-y-2 text-sm">
      <p className={state.ok ? "text-zinc-700 dark:text-zinc-300" : "text-red-700 dark:text-red-400"}>{state.message}</p>
      {state.counts.length > 0 ? (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-zinc-600 dark:text-zinc-400">
          {state.counts.map((c) => (
            <div key={c.label} className="contents">
              <dt>{c.label}</dt>
              <dd className="text-right tabular-nums">{c.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {state.notes.map((n) => (
        <p key={n} className="text-amber-700 dark:text-amber-500">{n}</p>
      ))}
    </div>
  );
}

export function RunMatcherForm() {
  const [state, action, pending] = useActionState(runMatcherAction, null);
  return (
    <form action={action} className="space-y-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Run the application matcher</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Proposes application matches and moves the matcher state to <code>completed</code> or <code>failed</code>. It
        proposes only — it never accepts or rejects a match, and re-running leaves decisions a human already made
        exactly as they are.
      </p>
      <button type="submit" disabled={pending}
        className="rounded bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
        {pending ? "Running…" : "Run matcher"}
      </button>
      <Outcome state={state} />
    </form>
  );
}

/**
 * `blockedReason` is presentation only. The server action re-derives the same precondition from the persisted state and
 * refuses on its own authority — hiding a button stops an accident, not an attacker, and this component is the half a
 * hostile client simply would not run.
 */
export function RunEvaluationForm({ blockedReason }: { blockedReason: string | null }) {
  const [state, action, pending] = useActionState(runEvaluationAction, null);
  const blocked = blockedReason !== null;
  return (
    <form action={action} className="space-y-3 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-medium">Run the cross-source governance evaluation</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Loads the canonical evidence, evaluates the rules, and reconciles findings through migration 0083 — opening,
        refreshing, reopening and closing them. A finding is closed only where the run could prove the condition ended.
      </p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Requires the application matcher to be <strong>currently</strong> completed. The engine preserves closure safety
        when matcher evidence cannot be re-proven, but an evaluation in that state is incomplete — it says nothing about
        unmanaged applications and may withhold finding closures. Run the matcher to completion first for a complete
        governance result.
      </p>
      {blocked ? <p role="status" className="text-sm text-amber-700 dark:text-amber-500">{blockedReason}</p> : null}
      <button type="submit" disabled={pending || blocked}
        className="rounded bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
        {pending ? "Evaluating…" : "Run evaluation"}
      </button>
      <Outcome state={state} />
    </form>
  );
}
