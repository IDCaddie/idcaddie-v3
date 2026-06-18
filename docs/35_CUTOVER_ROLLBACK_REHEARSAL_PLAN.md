# 35 · Cutover Rollback Rehearsal Plan

**Canonical plan for doc 17 blocker-sequence item #5** ([30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)): how a v3
cutover rollback is **rehearsed in staging** and later **executed during a real cutover** — satisfying
[17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) box **15** ("Documented rollback plan (DB + app),
rehearsed in staging"). **Planning only — this rehearses no rollback and mutates nothing.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **Cutover rollback rehearsal plan is prepared, not executed.** **No rollback was rehearsed by this PR.**
> - **No production project was touched. No staging data was mutated by this PR.** No DNS/Vercel/Auth/Storage/DB
>   change was made.
> - **No real OMC customer data is included.** **No secrets, passwords, anon keys, cookies, or JWTs are recorded.**
> - **No doc 17 §5 box is ticked here.** **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not
>   automatically production-ready. Storage completion is necessary but not sufficient for cutover.**
> - **OMC is a live production system** — rollback must return OMC to system-of-record **with no data loss**,
>   inside a bounded window. An agent never executes rollback, touches DNS/Vercel, or mutates hosted systems.

---

## 1. What "rollback" means for v3 replacing OMC (Task 1)

**Rollback = abandon the cutover and make the legacy OMC app the system-of-record again, safely, within a
bounded window, with no data loss or corruption and no cross-tenant exposure.** Because OMC is **live**, rollback
is not "redeploy the old build" — it must coordinate **traffic, data, files, sessions, the legacy app's
freeze state, and customer comms** so that any writes made to v3 during the (short) cutover window are either
reconciled back to OMC or provably absent. Two shapes:
- **Clean rollback (no v3 writes yet)** — flip traffic back to OMC, unfreeze OMC; v3 is unchanged-source.
- **Dirty rollback (v3 took writes)** — flip back, then **reconcile the v3-window writes into OMC** (or accept a
  documented, signed-off data-loss boundary). The cutover window is kept **short + write-gated** specifically to
  keep rollback in the "clean" shape.

Rollback is in scope from cutover start until the **point of no return** (PONR) is explicitly declared + signed
off (after which forward-fix replaces rollback).

---

## 2. Rollback domains (Task 2)

| Domain | Rollback action (human-executed later; NOT here) | Notes / current state |
|---|---|---|
| **DNS / routing / Vercel deployment** | Re-point the cutover domain back to OMC; demote/rollback the v3 Vercel production deployment to the prior (legacy-routing) state. | v3 staging exists ([24](./24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST.md)); production deploy not done. **No DNS/Vercel change in this PR.** |
| **Supabase DB restore point** | Restore the v3 production Postgres to the pre-cutover **restore point / PITR**; never edit a merged migration (forward-only) — rollback is *restore*, not down-migrations. | Migrations `0001`–`0015` forward-only; PITR/backup availability must be **confirmed** before cutover (precondition). |
| **Supabase Storage** | Preserve `contract-files` objects; rollback = stop new uploads + (if needed) restore objects from the restore point. **No object hard-delete** (no DELETE policy; cross-tenant delete already denied). | Private bucket + policies verified (staging+prod 14/14). |
| **Auth / session** | Invalidate v3 sessions (sign-out / cookie expiry); revert sign-in to OMC. Supabase Auth users for the customer are not destroyed by a traffic flip. | `getUser()` server-validated; no service-role on request paths. |
| **Legacy OMC freeze / unfreeze** | If OMC was frozen at cutover, **unfreeze** it (re-enable writes) and confirm it is healthy as system-of-record. | The freeze is part of the doc 34 Phase G migration window. |
| **Migration rollback / replay prevention** | Discard / quarantine the migrated v3 dataset for the window; **prevent replay** via the idempotent legacy-id→v3-id mapping ([34 §6](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md)) so a re-attempt does not double-load. | Non-destructive, idempotent design from doc 34. |
| **Customer communications** | Notify the customer (OMC) of the rollback, expected state, and any window-write reconciliation. | Comms template owned by the OMC owner. |
| **Monitoring + incident response** | Capture metrics/logs that triggered rollback; open an incident; record timeline. | **Post-cutover monitoring is NOT built** (doc 17 §3) — a prerequisite blocker. |

---

## 3. Staging rehearsal phases (Task 3 — human-run later, staging only)

Rehearse in **staging** with **synthetic** data (the [32](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)
OMC-shaped dataset + the [34](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md) Phase F rollback). **Never production; no real
data; no secrets recorded.**

| Phase | What | Safety |
|---|---|---|
| **R1. Tabletop rehearsal** | Walk the runbook end-to-end on paper: domains (§2), triggers (§4), owners (§5), timings, PONR. No system touched. | Discussion only. |
| **R2. Dry-run with synthetic staging data** | Execute the rollback steps against **staging** with synthetic data: flip a staging routing toggle, invalidate staging sessions, restore the staging DB from a staging restore point. | Staging only; ref-confirmed; synthetic. |
| **R3. Vercel preview/staging rollback simulation** | Demote a staging/preview deployment to a prior build; confirm the app serves the prior state. | Staging/preview only; **no production Vercel**. |
| **R4. Data restore simulation (if feasible)** | Restore the staging Postgres (+ Storage if supported) to a pre-load restore point; confirm the synthetic dataset is gone/reverted. | Staging only; restore-point first; synthetic. |
| **R5. Migration replay / idempotency rehearsal** | Re-run the (synthetic) staging load after a restore; prove the idempotent mapping prevents double-load and the reconciliation (doc 34 §5) still passes. | Staging only; non-destructive. |
| **R6. Evidence recording** | Record each phase's result + timings + owners (no secrets, no real data) per §6. | Names + pass/fail only. |

---

## 4. Production cutover rollback triggers (Task 4)

During a real cutover, **any** of these triggers a rollback decision (per §5) — they are objective, not judgment
calls mid-cutover:

| Trigger | Definition |
|---|---|
| **Auth/session failure** | Synthetic-or-canary users cannot log in / sessions don't persist against hosted Auth (item-#1 checks fail in production). |
| **Tenant isolation failure** | Any cross-tenant read/write/list is observed (RLS regression) — **immediate hard stop**. |
| **Data count mismatch** | Reconciliation (doc 34 §5) row/relationship counts don't match legacy per tenant beyond an agreed zero/near-zero tolerance. |
| **File access failure** | Authorized file upload/read fails, or **any** anon/cross-tenant file access succeeds (Storage REST checks fail in production). |
| **RLS regression** | The hosted RLS suite / spot checks diverge from the local suite (the `0015`-class divergence class) — **hard stop**. |
| **Unacceptable performance** | Latency/error rates exceed the agreed SLO for the critical flows. |
| **Customer blocker** | OMC reports a workflow they cannot perform that legacy supported (a parity gap surfaced live). |

---

## 5. Hard stop rules + decision owners (Task 5)

- **Immediate hard stop → rollback (no discussion):** any **tenant isolation failure**, any **cross-tenant or
  anon file access**, any **RLS regression**, or any **service-role on a request path**. These are
  zero-tolerance security failures.
- **Decision-required stop:** data count mismatch, auth/session failure, performance, customer blocker — the
  **cutover commander** decides rollback-vs-forward-fix within a bounded time, with the security owner holding a
  veto.
- **Decision owners (named roles, not individuals here):** **Cutover commander** (go/no-go + rollback call) ·
  **DBA** (DB restore) · **Platform/Vercel owner** (DNS/deploy) · **Security owner** (RLS/isolation veto) ·
  **OMC owner** (customer comms + acceptance). No agent is a decision owner; an agent executes nothing.
- **Point of no return (PONR):** explicitly declared + signed off only after reconciliation passes and the
  rollback window would exceed the agreed bound; after PONR, **forward-fix** replaces rollback. PONR is a
  human, recorded decision — never implicit.

---

## 6. Rollback evidence required before doc 17 box 15 (Task 6)

Box 15 is satisfiable **only** when all are recorded (names + pass/fail + timings; no secrets, no real data):
- The **rollback runbook** (this plan, finalized) reviewed + owned.
- A **green staging rehearsal** (R1–R6): the dry-run rollback + a **data restore** + the **migration
  replay/idempotency** rehearsal all passed in staging, with the post-restore reconciliation (doc 34 §5) green.
- **Confirmed production restore point / PITR availability** + the Vercel deploy-rollback path proven (in
  staging/preview).
- The **trigger list + hard-stop rules + named decision owners** agreed (§4/§5).
- A **rehearsed-rollback evidence record** (executor, reviewer, date, staging ref-confirmed, results) — a
  [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md)-style copy or `docs/evidence/rollback-rehearsal-<date>.md`.

Even with box 15 satisfied, **cutover stays a NO** until **every** doc 17 §5 box is true — rollback readiness is
necessary, not sufficient.

---

## 7. What this PR did / did NOT do (Task 7)

- **Did:** define rollback (§1), the rollback domains (§2), the staging rehearsal phases (§3), the production
  rollback triggers (§4), hard-stop rules + owners (§5), and the box-15 evidence (§6).
- **Did NOT:** rehearse or run any rollback; touch DNS/Vercel/GitHub settings; mutate production or staging or
  Supabase DB/Storage/Auth; run any hosted/production command; export or include real OMC data; record any
  secret; add code/migration/script. **No doc 17 box ticked.**

---

## 8. Risk posture

**RISK-001 remains OPEN** — a rehearsal *plan*, not a rehearsed rollback. **Post-cutover monitoring is still
not built** (doc 17 §3) and is a prerequisite for trigger detection (§4). RISK-002/007/013/015/016 remain open.
**Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but
not sufficient for cutover.** No production/staging mutation, no hosted command, no real OMC data, no secrets in
this PR. OMC/Flywheel is a paying production **replacement, not a pilot**.
