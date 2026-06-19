# 37 · Existing Parity / Cutover / Readiness Docs — Audit

**Purpose:** before writing *another* parity plan, take stock — what parity/cutover/readiness work is already
**documented**, what is **completed + recorded**, what is **planned but not executed**, what is **missing or
under-specified**, and where docs **overlap / drift**. **This PR audits existing parity documentation; it does
not implement parity.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.**
> - **Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**
> - **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage
>   completion is necessary but not sufficient for cutover.**
> - No doc 17 §5 box is ticked by this PR; no risk disposition is changed; no feature is built.

**Authoritative scale (measured):** doc 17 §5 cutover checklist = **17 boxes, 0 ticked / 17 unticked.** Doc 27
parity matrix ≈ **111 `missing` · 58 `partial` · 40 `blocked-unknown-legacy-behavior` · 22 `blocked-data-migration`
· 5 `blocked-security` · ~11 `deprecated-approved` · ~11 `complete`** — i.e. the overwhelming majority of legacy
behaviors are not yet built/verified.

---

## 2. Per-doc summary (parity / cutover / readiness docs)

Legend — **Type:** evidence · plan · runbook · design · blocker-tracker · reference. **Exec:** yes / partial /
no (has real/hosted work happened, or is it paper?). **Fut:** depends on future work. **R1:** affects RISK-001.
**Par:** affects old-app parity.

| Doc | Covers | Current? | Type | Exec | Fut | R1 | Par |
|---|---|---|---|---|---|---|---|
| 00 Product Status | running status + merged-PR ledger | current | reference | n/a | — | notes | yes |
| 04 Risk Register | RISK-001 (+002/007/013/015/016) disposition | current | blocker-tracker | n/a | — | **canonical** | yes |
| 05 Changelog | per-PR what/why | current | reference | n/a | — | notes | — |
| 09 Agent Handoff | standing rules + blocker-sequence state | current | reference | n/a | — | notes | yes |
| 10 Docs Index | the index | current | reference | n/a | — | — | — |
| 11 Legacy Parity & OMC Checklist | early capability scorecard (apps/contracts/people/UAR/license/audit) | **stale-ish** — narrower than 27 | blocker-tracker | partial | yes | no | yes |
| 12 Identity Matching Read-Scope | safe match-status read without leaking directory | current | design | partial (`0008` read shipped) | yes | no | yes |
| 13 Contract Steward Write | contract write authority + audit-on-write + UI | current | design | **yes** (`0004`/`0010`, PR #29–32) | yes | no | yes (partial) |
| 14 Legacy UX & Workflow Parity Map | per-workflow "same/better/removed" UX gate (17+ surfaces) | current | plan | no | yes | no | yes |
| 15 Legacy Contract Form Inspection | captured legacy contract create/edit fields | current | evidence | no (inspection) | yes | no | yes (partial) |
| 16 Contract PDF + AI Extraction | secure upload + AI extraction design | current | design | partial (`0012`/`0013`/validation) | yes | no | yes (not surfaced) |
| 17 OMC Replacement Parity Gate | **the binding go/no-go** (§4 matrix + §5 17-box checklist) | current | blocker-tracker | no (0/17) | yes | yes | **THE gate** |
| 18 OMC Confirmation Pass | workshop to resolve `unknown`/`probably` required-ness | current | runbook | **no — not run** | yes | no | yes (sizes scope) |
| 19 Connector Credential Vault | secret vault + secret-handling design | current | design | **no** (RISK-007) | yes | no | yes (gates connectors) |
| 20 Hosted Apply & Cutover Discipline | staging-first apply/verify/rollback discipline | current | runbook | n/a | — | plumbing | — |
| 25 Staging Schema+Storage Evidence | staging migrations+bucket+policies+**REST 14/14** | current | evidence | **yes (staging)** | — | criterion 1/2 ✅ | yes (boundary) |
| 26 Storage REST Verification Runbook | the staging REST verifier + how-to | current | runbook | **yes (run 14/14)** | — | supports | yes (boundary) |
| 27 Legacy OMC Full Parity Matrix | **the line-item master** (16 tracks A–P, ~95+ rows) | current | blocker-tracker | no | yes | no | **canonical matrix** |
| 28 Production Storage Apply Runbook | production apply steps | current | runbook | **yes (executed)** | — | criterion 3 | yes (boundary) |
| 29 Production Storage Evidence | production apply + **REST 14/14** + cleanup + `0015` | current | evidence | **yes (production)** | — | criterion 3/4 ✅ | yes (boundary) |
| 30 Cutover Blocker Sequence | the 6 ranked blockers + §6 hosted-RLS analysis | current | blocker-tracker | partial (#1 run) | yes | no | yes |
| 31 Hosted Auth + Tenant-Context | §7 Auth verify **PASSED 8/8 + manual A/B**; §8 cleanup | current | **evidence** | **yes (run green)** | — | criterion 5 (box 6) | yes (foundation) |
| 32 OMC-Shaped Dataset + Flow Validation | dataset + critical-flow validation runbook | current | runbook/plan | **no (prepared)** | yes | criterion 5 (box 7/9) | yes |
| 33 Required-Workflow Parity Build Plan | 9 tracks, P0/P1/P2, next-3 build PRs | current | plan | no | yes | no | yes (build map) |
| 34 OMC Legacy → v3 Data Migration | sources→targets, 8 phases, reconciliation | current | plan | no | yes | no | yes (box 16) |
| 35 Cutover Rollback Rehearsal | 8 domains, rehearsal phases, triggers | current | plan | no | yes | no | yes (box 15) |
| 36 OMC Acceptance & Signoff | signoff domains/roles/evidence/outcomes | current | plan | no | yes | no | yes (box 17) |
| current-product-map (lowercase) | **legacy Firebase app feature/route map** | current | evidence | n/a | — | no | **baseline** |
| current-security-risk-map | legacy risk register | current | evidence | n/a | — | context | no |
| v3-product-scope | original **MVP** subset (defers AI/connectors/dashboards/SSO/billing) | **stale for cutover** — narrower than 17/27 | plan | no | yes | no | yes (tension) |
| v3-data-model / v3-migration-plan | proposed schema / 10-step data pipeline | partial / superseded-ish | plan/runbook | no | yes | no | yes |

---

## 3. Existing completed evidence (actually done + recorded)

Only these have **real, recorded** completion:
1. **Staging Storage apply + REST authorization — DONE 14/14** (doc 25 / doc 26): migrations `0001`–`0014`, private
   `contract-files` bucket, 2 `authenticated` `storage.objects` policies (0 unsafe), `verify-staging-storage-rest.mjs`
   passed 14/14 on hosted staging (user-scoped JWTs, no service-role).
2. **Production Storage apply + REST authorization — DONE 14/14** (doc 29): same applied to production
   `dzbfxulvxchdemcettrx`, `verify-production-storage-rest.mjs` passed 14/14, synthetic cleanup complete, the
   `public.files` `authenticated` grant codified as migration `0015`. **(RISK-001 criteria 1–4 satisfied.)**
3. **Hosted staging Auth + tenant-context verification — PASSED** (doc 31 §7): on `https://idcaddie-v3.vercel.app`
   (after the Vercel `NEXT_PUBLIC_SUPABASE_*` env fix + redeploy), `verify-staging-auth-tenant-context.mjs` 8/8 +
   manual Tenant A/B browser checks — real hosted Auth, user-scoped JWTs, no service-role. Advances doc 17 §5
   **box 6** (and the isolation spot-checks of 5/8).
4. **Staging Auth synthetic-fixture cleanup/disposition — RECORDED** (doc 31 §8): tenant/org access removed
   (memberships = 0); 2 profiles + 2 tenants + 2 Auth users retained as audit anchors because `audit_logs` is
   append-only (immutability working as intended).
5. **Built read/write app surfaces (local, unverified-on-hosted-flows):** login/logout/session + read-only
   tenant/org context; apps list+detail; app-users roster + match-status + account-intelligence (read); contracts
   list+detail; contract create/edit (write, `0004` authority + `0010` audit); app↔contract link **panels (read)**.
   Local RLS suite **222** green. *These are built, not yet hosted-flow-validated.*
6. **Hosted-staging RLS unsafe-run gate — PREPARED** (doc 30 §6 + `scripts/verify-staging-rls-suite.mjs`): the
   analysis that the raw `org_rls_test.sql` (`TRUNCATE` of append-only `audit_logs` + `delete auth.users`) must
   not run against shared staging, and a ref-guarded refusal gate that connects to nothing.

**Everything in §3 is necessary but not sufficient. Storage completion is necessary but not sufficient for
cutover. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**

---

## 4. Existing planned but not executed

Paper only — reviewed plans/runbooks with **no hosted execution**:
- **OMC-shaped staging dataset + critical-flow validation** (doc 32) — runbook only; nothing loaded.
- **Required-workflow parity build plan** (doc 33) — no feature built.
- **OMC legacy → v3 data migration** (doc 34) — no migration tooling/run.
- **Cutover rollback rehearsal** (doc 35) — not rehearsed.
- **OMC acceptance / signoff** (doc 36) — no signoff recorded.
- **Hosted-staging RLS suite — disposable-isolated execution** (doc 30 §6 runbook) — not run; the gate emits a
  runbook for a human against a separate disposable project.
- **OMC confirmation pass** (doc 18) — not run; `unknown`/`probably` rows unresolved.
- **Connector credential vault** (doc 19) — design only (RISK-007 open).
- **Contract PDF upload + AI extraction** (doc 16) — schema/validation exist; no bucket-upload action / AI worker / UI.

---

## 5. Missing or under-specified parity areas (vs the legacy app)

Legacy feature inventory from `current-product-map.md`, mapped to v3 status. **built** = shipped surface;
**boundary-only** = schema/security exists, no UI/flow; **not built** = absent.

| Legacy area | v3 status | Gap |
|---|---|---|
| Old-app UI/UX shell, nav, breadcrumbs, loading/empty states | partial | authenticated shell only; UX parity not certified (doc 14) |
| Dashboard / home (metrics) | **not built** | no home metrics surface |
| Apps inventory / detail | **built (read)** | unverified-on-hosted; utilization/cost views partial |
| App users (roster) | **built (read)** | unverified; no write/manage |
| Identity users / employees (people directory) | **boundary-only** | `people`/`identity_accounts` schema only; no directory |
| App-user ↔ identity matching | partial | match-status read (`0008`); no matching algorithm/merge/UAR UI |
| Contracts workflows | **built (read + create/edit)** | partial fields (doc 15); **no delete/archive**, no link/unlink write |
| File workflows (upload / signed URL / preview) | **boundary-only** | bucket+policies+REST done; **no upload action/UI/signed-URL route/preview** |
| Spend / license / account intelligence | **mostly not built** | account-intelligence read only; license/spend = schema only |
| Shadow IT / unmanaged accounts (UAR) | **not built** | no UAR/stale-user/unmanaged-ratio |
| Import / export / reporting / dashboards | **not built** | no CSV/PDF export, no imports, no scheduled reports |
| AI contract analysis | **not built** (designed) | doc 16; no worker/UI |
| AI app / license intelligence | **not built** | no surface |
| API / SaaS connectors | **not built** (designed) | doc 19; gated on vault |
| Connector token storage / security (vault) | **not built** | RISK-007 open; prerequisite for any connector |
| Connector ingestion / audit logs | **not built** | no ingestion; audit table append-only but no connector writes |
| Admin / settings | **not built** | memberships in DB; no admin/settings UI |
| Audit viewer | **boundary-only** | `audit_logs` + `0010` write; no viewer UI |
| Old-app acceptance criteria | **under-specified** | doc 18 confirmation pass not run → `unknown`/`probably` rows undecided |

**Under-specified (needs OMC input before sizing):** the 40 `blocked-unknown-legacy-behavior` rows + every
`probably`/`unknown` required-ness in doc 17 §4 — all gated on the **doc 18 confirmation pass**, which has not
run. Until then the remaining build is unscoped (could be ~25 or ~110 PRs).

---

## 6. Duplicates / overlap / docs-drift risk

| Overlap | Docs | Recommendation |
|---|---|---|
| **Parity is tracked in 5 places** | 11, 14, 17 §4, 27, 33 | **doc 27** = canonical line-item matrix; **doc 17** = canonical gate; **doc 33** = canonical build plan. Mark **11** and **14** as *superseded-by → 27/17* (keep as history) to stop them drifting from 27. |
| **MVP scope vs full-replacement bar** | v3-product-scope vs 17/27 | **RESOLVED** by the decision of record [38_OMC_FULL_PARITY_SCOPE_DECISION](./38_OMC_FULL_PARITY_SCOPE_DECISION.md): full old-app parity is the cutover bar unless OMC waives a capability in writing; `v3-product-scope` is annotated **superseded for cutover** (kept as history). |
| **Data-migration plan stated twice** | 34 vs v3-migration-plan | **doc 34** canonical; mark v3-migration-plan superseded. |
| **Rollback / stop rules restated** | 20, 28 §10, 34 phase F, 35 | **doc 35** canonical rollback; others link to it. |
| **RISK-001 narrative restated** | 00, 04, 09, 25, 29, 30, 31 | by-design banners, but drift risk if one lags — **doc 04 RISK-001 row is the single source of truth**; others should link, not re-assert criteria. |
| **Storage runbook/evidence set** | 22/23/26/28/29 | coherent (staging vs prod, runbook vs evidence) — **no consolidation needed**; leave as-is. |

A cheap docs-only **consolidation PR** (add "superseded-by" headers to 11, 14, v3-product-scope, v3-migration-plan;
point them at 27/17/33/34) would materially reduce drift risk.

---

## 7. Recommended next PR sequence (from this audit only)

No invented completed work. Realistic order:

1. **Run the OMC confirmation pass (doc 18)** — *highest-value for de-risking.* It resolves the 40
   `blocked-unknown` + the `probably`/`unknown` required-ness rows, which **sizes** the entire remaining build
   (may shrink it dramatically). Workshop + a docs PR recording decisions into doc 17/27. (Human-led.)
2. **Execute the prepared hosted-staging RLS suite** against a disposable-isolated project (doc 30 §6 runbook) →
   record evidence → completes the hosted half of doc 17 §5 boxes 5/8. (Human-run; then a docs evidence PR.)
3. **Execute item #2** (doc 32): load the OMC-shaped synthetic dataset + validate the *implemented* critical flows
   → record evidence (box 7 + partial box 9). (Human-run; then a docs evidence PR.)
4. **Docs consolidation PR** (§6) — supersede 11/14/v3-product-scope/v3-migration-plan; kill drift. (Cheap, docs-only.)
5. **First real build PRs (doc 33 T3, P0):** contract-file **upload action + signed-URL read** (sits on the done
   Storage boundary) → files list/detail/preview → contract field-parity + app↔contract link/unlink write. Each
   cites its doc 27 row(s), carries RLS tests + hosted staging validation + evidence, ticks no §5 box on its own.

---

## 8. Bottom-line parity status

- **Is v3 the same as the old app today?** **No.** v3 has login/session + tenant/org context, apps & contracts
  **read**, contract **create/edit**, and a verified Storage **boundary**. The legacy app's dashboard, file
  upload/AI, people/identity/UAR, license/spend, imports/exports/reporting, admin/settings, and connectors are
  **not built**. **Old-app parity is not complete.**
- **Is UI/UX parity complete?** **No. UI/UX parity is not complete** — the authenticated shell + a few read/write
  surfaces exist; most legacy surfaces are absent and UX parity is uncertified (doc 14).
- **Is AI/API connector parity complete?** **No. AI/API connector parity is not complete** — AI extraction (doc 16)
  and connectors (doc 19) are **design only**; the connector credential vault is not built (RISK-007).
- **Is cutover approved?** **No. Cutover remains BLOCKED** — doc 17 §5 is 0/17; **RISK-001 remains OPEN** (criteria
  1–4 met, criterion 5 — the §5 checklist — is not). **Hosted Auth/tenant-context is verified, but old-app
  replacement is not yet verified.** **Upload is not automatically production-ready. Storage completion is
  necessary but not sufficient for cutover.**
- **What is the next highest-value PR?** **Run the OMC confirmation pass (doc 18)** to resolve the `unknown`/
  `probably` rows and *size* the replacement — it determines whether the remaining build is ~25 or ~110 PRs and
  unblocks doc 17 boxes 3/4. The cheapest concrete next step is executing the **prepared hosted-staging RLS run**
  (doc 30 §6); the highest-value *build* PR is the **contract-file upload action** (doc 33 T3), which sits on the
  already-verified Storage boundary.

**This PR audits existing parity documentation; it does not implement parity.** No doc 17 box ticked; RISK-001
disposition unchanged.
