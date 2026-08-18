// Phase 18F-C — the INTERNAL governance ops surface. Not customer-facing, not in the nav, not a findings UI.
//
// It answers one question an operator could not answer at all before: what state is the governance engine in, and how
// do I run it. It shows engine OPERABILITY — matcher state, run outcomes, why a rule stayed quiet — and deliberately
// shows no finding content: what the findings SAY is a customer surface and belongs to another lane.
//
// Gated twice. The env flag decides whether the surface exists at all (fail-closed, off unless explicitly set), and
// `accessGate()` inside every read and action admits only an owner/admin of a single active tenant. The buttons render
// only when both hold, and the server actions re-check the flag themselves — this page is never trusted.

import { readTenantMatcherState } from "@/lib/data/governance-ops";
import { evaluationGate, isGovernanceOpsEnabled, toMatcherStateView } from "./governance-ops-view";
import { RunEvaluationForm, RunMatcherForm } from "./run-panel";

export const metadata = { title: "Internal governance ops · ID Caddie" };

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-700 dark:text-zinc-300">{value}</span>
    </div>
  );
}

export default async function GovernanceOpsPage() {
  if (!isGovernanceOpsEnabled(process.env)) {
    return (
      <main className="flex flex-1 flex-col gap-4 p-8">
        <h1 className="text-xl font-semibold">Internal governance ops</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This internal trigger is not enabled in this environment.
        </p>
      </main>
    );
  }

  const read = await readTenantMatcherState();
  // A read we could not complete blocks the evaluation button too. Rendering it enabled on an unknown state would
  // invite the exact press the server action is going to refuse anyway.
  const gate = read.ok ? evaluationGate(read.state) : null;
  const blockedReason = gate === null
    ? "Evaluation is unavailable while the matcher state cannot be read."
    : gate.allowed ? null : gate.message;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Internal governance ops</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Manual, request-driven operation of the governance engine. Every run below happens because a person pressed a
          button — <strong>there is no scheduler</strong>, so nothing here runs unattended. Writes go through Postgres
          RLS <strong>as you</strong>, never service-role. Internal only — not customer-facing.
        </p>
      </header>

      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Application matcher state</h2>
        {!read.ok ? (
          // A read failure is never rendered as "never run". One is a fact about the customer's estate; the other is a
          // fact about our access, and showing the first when the second is true is how an operator concludes the
          // matcher needs running when it may have run fine.
          <p className="text-red-700 dark:text-red-400">
            {read.error === "not_authorized"
              ? "You don’t have access to this area — owner or admin of a single active tenant is required."
              : "Could not read the matcher state right now. This is not a statement about whether it has run."}
          </p>
        ) : (
          (() => {
            const view = toMatcherStateView(read.state);
            return (
              <div className="space-y-2">
                <Field label="Status" value={view.headlineLabel} />
                <Field label="Current run started" value={view.startedAt ?? "—"} />
                <Field label="Last successful completion" value={view.lastCompletedAt ?? "never"} />
                {view.historicalCompletionNote !== null ? (
                  <p className="text-amber-700 dark:text-amber-500">{view.historicalCompletionNote}</p>
                ) : null}
                <p className={view.rule5Licensed ? "text-zinc-600 dark:text-zinc-400" : "text-amber-700 dark:text-amber-500"}>
                  {view.consequence}
                </p>
              </div>
            );
          })()
        )}
      </section>

      <RunMatcherForm />
      <RunEvaluationForm blockedReason={blockedReason} />

      <footer className="text-sm text-zinc-500">
        Run outcomes above are shown to the operator who triggered them and are not persisted — see{" "}
        <code>docs/runbooks/GOVERNANCE_OPS_RUNBOOK.md</code>.
      </footer>
    </main>
  );
}
