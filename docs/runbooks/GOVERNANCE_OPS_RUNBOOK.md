# Governance ops runbook — manual operation of the governance engine

> **THERE IS NO SCHEDULER.** Nothing in this system runs the application matcher or the governance evaluation on a
> timer, a cron, a webhook, a login or a page load. Every run below happens because a named person pressed a button and
> is present to read the result. This is not a temporary state pending automation — it is the assumption the rest of
> this runbook rests on, and §10 states exactly what would have to change first.

Surface: `/internal/governance-ops` (internal, not linked from the customer navigation, not a findings UI).

## Preconditions (all must be ✅)
- [ ] `ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED=1` in the target environment · [ ] signed in as **owner or admin** of a
      **single active tenant** · [ ] migrations through **0091** applied to that database (see §8)

Both gates are fail-closed and independent: the flag decides whether the surface exists, and the role is re-verified
inside every `SECURITY DEFINER` RPC by `has_tenant_role`. Writes happen as the signed-in operator under RLS. There is no
service-role path and no machine principal — a run cannot happen without a human session.

---

## 1. What the two buttons do

| Button | Calls | Writes |
|---|---|---|
| **Run matcher** | `runTenantApplicationMatcher` | `application_matcher_state` (0085), `application_matches` proposals (0088/0090) |
| **Run evaluation** | `evaluateTenantCrossSourceGovernance` | `governance_findings` via `product_sync_governance_findings` (0083/0091) |

**Order is a hard precondition, not a preference.** The evaluation **refuses to run** unless the matcher's *current*
status is `completed`. The button is disabled and the server action refuses independently, so a stale page or a direct
POST cannot get past it.

| Sequence | Result |
|---|---|
| matcher → `completed` → evaluation | allowed |
| matcher fails → evaluation | **refused** — re-run the matcher first |
| matcher still running → evaluation | **refused** — wait |
| matcher never run → evaluation | **refused** — run the matcher first |
| `last_completed_at` set but current status is `failed`/`running` | **refused** — history does not authorize a run |

### Why evaluation-alone is NOT safe when the matcher is not completed

Rule 5's findings carry the application's connection as their evidence. Migration 0083 closes any open finding of this
engine that is **absent from a run's payload** and whose evidence connections are all closure-eligible — a flat subset
test that knows nothing about which rule produced a finding, or whether that rule ran.

So when the matcher is not `completed`, rule 5 is withheld, its findings vanish from the payload, and the connector is
still healthy — therefore still closure-eligible. 0083 reads "absent + covered" as "the condition ended" and **closes a
finding that is still true**. It is counted in `closed`, never in `withheld_from_closure`, so nothing on screen would
tell you anything was lost. Since #431, those findings are customer-visible at `/access/governance`, where the close
reads as *resolved*.

**A withheld rule is therefore not, by itself, a licence to close anything** — but 0083 cannot tell the difference. This
runbook's precondition is what keeps the operator out of that state.

> **Scope of the fix.** The guard lives in this operator surface only. It does **not** repair 0083's closure model —
> that needs a migration carrying per-rule/per-capability closure scope. Any other caller of the engine is exactly as
> exposed as it was before. Do not read this section as "the engine is closure-safe".

## 2. Reading the matcher state

The page shows four states, and they are not interchangeable:

| Shown | Means | Rule 5 |
|---|---|---|
| **Never run** | no row exists; nobody has looked | withheld — an unmatched application is *unknown*, not *unmanaged* |
| **In progress** | a run started and has not finished | withheld — its output is not yet complete |
| **Completed** | the last run finished successfully | **licensed** |
| **Failed** | the last run did not finish | withheld — absence of a match proves nothing |

**"Last successful completion" is not the status.** `application_matcher_state.last_completed_at` deliberately survives a
later failure — an earlier run really did complete. So a matcher that failed at 11:02 still shows a completion at 09:14,
and rule 5 stopped firing at 11:02. The page labels the surviving timestamp as historical for exactly this reason. When
they disagree, **the status is the truth**.

## 3. Successful completion

The run reports: directory applications seen, product-unresolved, resolved-zero-instance, one-candidate and ambiguous
counts, candidate rows read, and proposals created / already present / already accepted / already rejected.

`completed` means complete **relative to this run's own bounded reads**, not to a database snapshot. The census and the
candidate feed are separate cursor walks; an application created between them belongs to the next run, not this one.

## 4. Failure

Every failure after the start marks the run `failed` and stops. There is no partial completion and no best-effort path,
because a completed run is what licenses rule 5 against the customer's estate.

The bounded reason is shown to the operator who triggered the run. It is one of a fixed vocabulary — `not_authorized`,
`query_failed`, `pagination_contract_violated`, `page_limit_exceeded`, `proposal_rejected`, `state_transition_failed`,
or an evidence violation (`candidate_absent_from_census`, `conflicting_products`, `mixed_null_and_concrete`,
`duplicate_candidate_row`). A reason outside that vocabulary is reported as unrecognised **without** its content, and
the detail is in the server logs.

| Reason | First check |
|---|---|
| `not_authorized` | role is owner/admin; exactly one active tenant |
| `query_failed` | migration level (§8); database reachability |
| `pagination_contract_violated` / `page_limit_exceeded` | a canonical read broke its ordering or size contract — this is a defect beneath the matcher, not an operational condition. Do not re-run repeatedly; escalate. |
| `proposal_rejected` | the review boundary refused a proposal — escalate, do not widen the boundary |
| evidence violations | the canonical layer disagreed with itself — escalate |
| `state_transition_failed` | a concurrent run took over (§5) |

**The reason is not persisted.** An operator arriving later sees `failed` with no reason. That is intentional and safe
while runs are attended: the remedy is to re-run and read the reason yourself (§5).

## 5. Safe retry

**Re-running the matcher is safe at any time, from any state.** `product_start_application_matcher_run` upserts
unconditionally, so a new run simply takes over.

**A stuck "In progress" is not a deadlock.** It means one of:
- the request died mid-run (timeout, deploy, browser close) and nothing marked it failed; or
- the run failed and the follow-up `product_fail_application_matcher_run` also failed (best-effort by design, so that a
  bookkeeping failure never overwrites the real reason).

In both cases the remedy is the same: **press Run matcher again.** There is no lock to clear and no row to repair.

While the matcher is stuck at `running`, rule 5 is withheld **and the evaluation is refused** (§1). Do not try to
"work around" the refusal by evaluating anyway from another path — that is precisely the state in which 0083 would
close still-true unmanaged-application findings.

Do **not** retry in a loop. The surface runs the engine exactly once per press, on purpose; an automatic retry would
hide an intermittent failure behind an eventual success and would be the first step toward unattended execution.

### Two operators at once

There is no concurrency lock — `product_start_application_matcher_run` upserts unconditionally, which is exactly what
makes the retry above safe. Concurrent *matcher* runs are bounded and non-destructive:

- both runs propose the same deterministic set; `product_propose_application_match` is `on conflict … do nothing`, so no
  duplicate row and no duplicate accepted match can appear;
- accepted/rejected decisions are never touched by either run;
- whichever run finishes second finds the row no longer `running` and reports `state_transition_failed`. **The persisted
  state can therefore read `completed` while an operator is looking at a "failed" message.** The persisted state is the
  truth; re-read it before acting.

**The one race that matters** is matcher-vs-evaluation. The evaluation's precondition and the engine's own matcher read
are two separate statements, so another operator starting a matcher run in between can flip the state after the
evaluation was authorized. This cannot be closed from the operator surface — the engine, not the guard, decides whether
rule 5 fires — so it is **detected instead**: a run that was authorized but comes back reporting rule 5 as withheld
raises an `ANOMALY` note telling you findings may have been wrongly closed, and what to do about it.

**If you see that note:** re-run the matcher to a successful completion, evaluate again (which reopens anything wrongly
closed, incrementing `reopen_count`), and confirm with the other operator. Avoid it by not running the matcher and the
evaluation from two sessions at the same time — attended operation is the only sequencing this phase has.

## 6. Decision preservation

**The matcher proposes and nothing else.** It never calls `product_decide_application_match`. A match is a human
judgement about a customer's estate.

Re-running therefore **cannot** reset a decision. A pair a person has already accepted or rejected comes back as
`already_accepted` / `already_rejected`, which the run counts as **successes** and the page labels as *"Already accepted
by a human"* / *"Already rejected by a human"*. If either ever surfaces as an error, that is a defect: treating a
settled rejection as a failure pressures the next maintainer into re-proposing around it.

One candidate does not auto-accept either — cardinality is not evidence.

## 7. Finding sync

The evaluation reconciles findings through 0083 and reports six numbers: **reported, opened, reopened, refreshed,
closed, withheld from closure**.

**A withheld closure is correct behaviour, not a failure.** A finding closes only when every connection its evidence
rests on is in the run's complete set (`evidence_connection_ids <@ p_complete_connection_ids`) — i.e. only when this run
could *prove* the condition had ended. A stale, failed, plan-limited, permission-limited or undeclared source can never
license a closure, so the finding stays open and the count says so.

The remedy is to sync the connectors it depends on and re-run. The remedy is **never** to widen what counts as complete:
that closes findings on evidence that proved nothing.

**A withheld RULE is a different fact.** A rule that did not run at all is reported separately, with its reason (e.g.
*"the application matcher has never run"*). Zero closures does not tell you a rule ran; the withheld-rule list does.

A load failure aborts before any sync. Nothing is written and nothing closes — a read we could not complete must never
become a closure. The matcher-state precondition in §1 is the same principle applied one level earlier: a rule we could
not evaluate must never become a closure either.

## 8. safeupdate compatibility (migration 0091)

Managed Supabase preloads the `safeupdate` extension, which rejects any UPDATE or DELETE whose parse tree carries no
WHERE clause. Before 0091, `product_sync_governance_findings` cleared its reporting table with a bare `delete from
reported_findings;`, so **every hosted call failed** with `SQLSTATE 21000 · DELETE requires a WHERE clause` while stock
Postgres, CI and every local suite passed.

Operationally: **if "Run evaluation" fails with `query_failed` on a hosted database, check that 0091 is applied before
investigating anything else.** Stock Postgres does not load the extension, so a local reproduction will not show it.

## 9. Provider dormancy

A connector that has never synced, or whose last sync was stale or failed, does not have its capability marked
`available` — so it is absent from the run's complete set. The consequences are all *conservative* and none is an error:

- its evidence is not counted as complete, so findings that depend on it are **withheld from closure** (§7);
- a rule with no complete source is **withheld** entirely, with that reason;
- the matcher's census excludes stale applications deliberately, so a dormant directory shrinks the census rather than
  manufacturing unresolved products.

Dormancy is therefore visible as withheld counts and withheld rules, never as a fabricated clean run. Sync the connector
and re-run. **This holds for connector dormancy specifically**, because a degraded capability removes that connection
from the closure-eligible set. It does *not* generalise to a failed matcher: there the connector stays healthy and
therefore closure-eligible, which is why §1 makes matcher completion a precondition rather than advice.

## 10. What is NOT persisted, and what Phase 18G would need

Persisted today (0085): matcher `status`, `started_at`, `last_completed_at`. That is all.

**Transient** — returned to the operator who pressed the button, gone when the request ends: every matcher count, every
sync count including `withheld_from_closure`, the bounded failure reason, and the withheld-rule reasons.

This is sufficient **only because every run is attended**, and recovery from a lost response is well-defined: re-read
the matcher state on this page, re-run the matcher if it is not `completed`, and evaluate only once it is. Both engines
are deterministic and idempotent over unchanged evidence, so nothing is lost by repeating a run whose result you never
saw — the counts are recomputed rather than recovered. The one number that cannot be reconstructed after the fact is
`withheld_from_closure`; re-running is how you get it back, and §1's precondition is what makes that re-run safe.

Before any scheduler, background worker or unattended execution is introduced, the following become load-bearing and
must exist first:

1. **A run record with a bounded failure reason.** The precedent already exists in this repository: `manual_sync_runs`
   (0037) — `status` ∈ (running, succeeded, failed), `error_code`, `failed_stage`, per-run counts, `started_at` /
   `finished_at`, append-only, tenant-scoped, RLS-read by members. A matcher run record should follow it rather than
   invent a shape. Note 0037's `source` CHECK admits only `'slack'`, so reuse means widening that constraint — a
   migration decision, not a free one.
2. **A concurrency lock.** `manual_sync_runs` has one (0038: a partial unique index on `status = 'running'`);
   `application_matcher_state` deliberately does not — `start` upserts over a `running` row, which is what makes §5's
   retry safe and what makes an unattended runner able to stamp over a live run.
3. **A machine principal.** Every RPC on this path gates on `has_tenant_role(owner|admin)` against `auth.uid()`. There
   is no identity an unattended runner could present today, and creating one is a trust-boundary change.
4. **Persisted sync summaries**, so "did anything close last night, and what was withheld" is answerable without a human
   having been present.
5. **A closure model that respects rule gating** — 0083 currently closes on "absent from payload + evidence covered",
   which cannot distinguish "the condition ended" from "the rule did not run" (§1). Attended operation is guarded by the
   precondition; an unattended runner would need the migration.

Until all four exist, the honest statement is the one at the top of this document: there is no scheduler, and the
backend is operationally supportable without one.

## 11. Staging acceptance

Fixture requirements: a tenant with an owner/admin operator, at least one connector whose `directory_applications`
capability is `available`, and migrations through 0091.

1. Set `ID_CADDIE_INTERNAL_GOVERNANCE_OPS_ENABLED=1`; open `/internal/governance-ops`.
2. Record the matcher state **before** any run. On a fresh fixture this must read **Never run** — not "Completed with
   zero". If it reads anything else, note what and why.
3. Run the evaluation **first**, before the matcher. Expected: the button is **disabled** and, if invoked directly, the
   action **refuses** with the never-run reason. This is the acceptance evidence that the precondition bites and that
   never-run is not a zero.
4. Run the matcher. Expected: **Completed**, with a census count matching the tenant's current directory applications.
5. Re-run the matcher immediately. Expected: **Completed** again, `Proposals created: 0`, and any prior human decisions
   reported as already accepted / already rejected. This is the decision-preservation evidence.
6. Run the evaluation again. Expected: rule 5 now evaluated rather than withheld; record opened/refreshed/closed and
   `withheld from closure`.
7. **Closure-safety evidence.** With at least one rule 5 finding open, force a matcher failure (or catch one), then
   attempt the evaluation. Expected: **refused**, and the finding is still `open` at `/access/governance`. Record both.
8. Re-run the matcher to a successful completion and evaluate again. Expected: allowed; the finding is refreshed, not
   reopened (its `first_seen_at` and `reopen_count` are unchanged) — proving nothing was closed behind your back.
9. Capture screenshots of steps 2, 3, 5, 6 and 7 into `docs/evidence/`.

A failure at any step is recorded with its bounded reason and the step number. Do not proceed past a failure by
re-running until it passes — an intermittent failure is a finding, not noise.
