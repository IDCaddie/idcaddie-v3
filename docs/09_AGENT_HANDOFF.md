# 09 · Agent Handoff

**Canonical source for: how a coding agent (Claude/Codex/etc.) safely continues work.**
Read this + [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) before doing anything. Repo rules
also live in `AGENTS.md` / `claude/CLAUDE.md`.

## Current repo state (verify before trusting — see [00](./00_PRODUCT_STATUS.md))
Read-only governance foundation + the **contract write workflow** (PRs through #34 merged — create/edit UI + parity
fields `0011` + PDF/AI **design** [16] + `files` metadata foundation `0012`; **Partial** parity still. **#35 adds the
`files` RLS policies** — migration `0013`: SELECT `is_tenant_member` (tenant-member read; org-scoped deferred) + INSERT
`uploaded_by = auth.uid() AND can_write_contract(contract_id, tenant_id)` (the `0004` contract-write authority — tenant
editor+ OR procurement-org manager; **`paying_org` grants no write**); **no UPDATE/DELETE/FOR ALL**. `files` now has a
**tested read+write authorization model** but is **still NOT surfaced** — no Storage, upload, signed URLs, scan/AI, UI,
or app DAL touches `files`).
Migrations `0001`–`0013` are `implemented`, `verified-local`, `ci-enforced`, and now **`staged`** (applied to
staging `ycdpzduxugdsffjqyoai` — PR #47/#48; **not** production-applied; Storage object policies + verification
pending — RISK-001 partial/OPEN). Migration `0014` (contract-file Storage auth helpers — PR #51) is `verified-local` + `ci-enforced` but **not yet staged** (`org_rls_test.sql` = 222 assertions, T1–T35; 67 vitest tests). Auth/session skeleton, read-only
tenant/org context, and a typed DAL are built. **Product surfaces ship:** `/apps`
+ `/apps/[id]` (with app-user roster, match-status column, account-summary card), `/contracts` +
`/contracts/[id]`, and linked app↔contract panels — read-only, RLS-scoped — **plus** the contract
**create/edit** write surface (`/contracts/new`, `/contracts/[id]/edit`). **Not** exercised
against hosted Supabase. **Design-only:** identity matching read-scope (doc 12; match-status slice
built). **Contract PDF/AI extraction** (doc 16): **design (#33) + `files` schema (`0012`, #34) + `files` RLS (`0013`, #35)**
exist; the upload/Storage/signed-URL/scan/AI/UI surface does **not** — `files` is authorized-by-design + tested but **not
surfaced** (no app DAL/route/UI touches it). **Contract steward write** (doc 13): RLS
authority (`0004`) + audit (`0010`, PR #29) + write path (PR #30) + create/edit UI (PR #31) + parity fields (`0011`,
PR #32) all exist; **legacy parity is still Partial** (`commodity_*`/`validated`/gantt — gaps in [15]; PDF/AI surface is
**not built** — [16]). No contract delete/archive, no link/unlink, no file UI/upload/Storage/AI;
no tenant switching, no provisioning, no UAR, no hosted apply.
Vercel **Web Analytics + Speed Insights** are present (platform telemetry only, bare components). Legacy
Firebase is still production; OMC cutover + new paid-customer onboarding **blocked**. Don't trust any
prompt's "seeded" history — re-verify from `git log`, `gh pr list`, `ls supabase/migrations`, and the source/test files.

## Non-negotiable rules
- **OMC/Flywheel is a paying production REPLACEMENT, not a pilot.** Never say "pilot", "pilot-ready", or "MVP pilot"; never optimize for a minimal viable pilot. Optimize for production-replacement parity (no missing/broken workflows) per [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md). Do not introduce product improvements before replacement parity unless explicitly `better-approved` (17 §6). Do not claim cutover-readiness; cutover is a NO until every 17 §5 box is true.
- **Full OMC parity is required BY DEFAULT** ([27_LEGACY_OMC_FULL_PARITY_MATRIX](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) is the master line-item tracker). **Do not narrow OMC replacement to "OMC-critical workflows only"** unless the specific matrix row is explicitly `deprecated-approved` (owner + OMC signoff — never a developer assumption). **Future feature work must cite the relevant doc 27 row(s)** it advances, with evidence; "better than legacy" / "contracts done" does not satisfy a row. **Missing or unknown legacy behavior remains an OMC blocker until inventoried** (`blocked-unknown-legacy-behavior`) **or `deprecated-approved`.** Doc 27 implements nothing, proves no parity, and does **not** close RISK-001 or authorize cutover. **The ranked sequence of the remaining doc 17 §5 cutover blockers + the next 3 PRs is [30_DOC17_CUTOVER_BLOCKER_SEQUENCE](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)** — the Storage path is complete but **not sufficient** for cutover (1 of 17 boxes' boundary; 16 remain); RISK-001 stays OPEN; cutover BLOCKED. The next 3 PRs are hosted-staging Auth + full RLS-suite-on-hosted verification, then an OMC-shaped dataset + critical-flow validation plan, then a required-workflow parity build plan from doc 27 — not cutover. **Item #1 (Auth/tenant-context) is now RUN GREEN** — a human ran `scripts/verify-staging-auth-tenant-context.mjs` against the deployed staging app `https://idcaddie-v3.vercel.app` (after correcting + redeploying the Vercel `NEXT_PUBLIC_SUPABASE_*` env to staging): **8/8 automated + manual Tenant A/B passed**, real hosted Auth + user-scoped JWTs, no service-role, no production touched, no secrets — evidence in [31 §7](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md) (advances doc 17 §5 boxes 5/6/8; the full RLS-suite-on-hosted re-run + dataset/critical-flows remain). The synthetic-fixture cleanup is recorded ([31 §8](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)): tenant/org access removed (memberships=0); **2 profiles + 2 tenants + 2 Auth users retained as audit anchors** because `audit_logs` is append-only (`reject_audit_mutation()`, `0002`) — immutability working as intended; the retained users have no tenant/org access. **The full `org_rls_test.sql` re-run against hosted (remaining part of boxes 5/8) is PREPARED, not yet run** — `scripts/verify-staging-rls-suite.mjs` ([30 §6](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)) is a ref-guarded refusal gate: the raw suite `TRUNCATE`s 17 tables (incl. append-only `audit_logs`, bypassing the row-level trigger) + `delete from auth.users`, so it must **never** run against the shared staging project even rollback-only; the gate refuses, connects to nothing, and only an explicit disposable-isolated opt-in **emits a rollback-only runbook** (count-snapshot → `begin…rollback` → verify counts unchanged → dispose) for a human to run against a separate disposable project — no connection string handled, no secrets printed. **Item #2 is PREPARED (not executed):** item #2 (OMC-shaped dataset + critical-flow validation) = the runbook [32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md) (dataset definition + validation plan + a review-and-apply SQL template — **runbook only, no committed runnable seed; not-built flows are blockers, not failures**). Both are staging-only, synthetic, no secrets; the hosted run + the manual UI steps + the synthetic-user/dataset setup are human-executed later. **An agent never runs the hosted verifier, seeds staging, or creates hosted users.** **Item #3 (required-workflow parity build plan) is now PREPARED** — the ranked, buildable plan (9 implementation tracks, P0/P1/P2, P0 detail, built-but-unverified-vs-not-built, and the next 3 implementation PRs) is in [33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md). The next 3 **implementation** PRs (contract-file upload action + signed-URL read; files list/detail/preview; contract field-parity + link/unlink write) build on the verified Storage boundary **after** items #1/#2 are executed green; each must cite its doc 27 row(s), carry RLS tests + hosted staging validation + evidence, and tick no §5 box on its own. **Item #4 (OMC legacy → v3 data migration plan) is now PREPARED** — [34_OMC_LEGACY_DATA_MIGRATION_PLAN](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md) (sources→targets, blocked-until-built, 8 phases, reconciliation incl. file byte/`sha256`, non-destructive rules, security/privacy, named tooling PRs, evidence). **Planning only — no migration tooling/run; migrate only built+verified surfaces; never migrate connector secrets (RISK-007) or via `local_demo.sql` (RISK-015); never service-role on a request path; no real OMC data in the repo.** An agent never runs a migration, exports real OMC data, or seeds hosted data. **Item #5 (cutover rollback rehearsal plan) is now PREPARED** — [35_CUTOVER_ROLLBACK_REHEARSAL_PLAN](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md) (rollback definition, 8 domains, 6 staging rehearsal phases, 7 production triggers, hard-stop rules + named decision owners + PONR, box-15 evidence). **Planning only — no rollback rehearsed/run; no DNS/Vercel/Auth/Storage/DB change.** An agent never executes rollback, touches DNS/Vercel, or mutates hosted systems. **Item #6 (OMC acceptance/signoff plan) is now PREPARED** — [36_OMC_ACCEPTANCE_SIGNOFF_PLAN](./36_OMC_ACCEPTANCE_SIGNOFF_PLAN.md) (acceptance definition, 8 signoff domains, signers-by-role, evidence package, 4 outcomes, approved-removal recording via the doc 27/17 taxonomy, evidence format, hard rules). **All six doc 17 blocker-sequence items (#1–#6) now exist as PREPARED plans — none executed.** What remains is the real work: execute the hosted Auth/dataset verifications (items #1/#2), build the required workflows (item #3 plan), run the migration + reconciliation (item #4), rehearse rollback (item #5), and record OMC acceptance (item #6) — each a human-executed step. **No signoff is recorded; engineering never self-accepts customer readiness; an agent never records a signoff, runs a hosted verification, or executes cutover.** RISK-001 stays OPEN; cutover BLOCKED until every doc 17 §5 box is true.
- **Never collect, request, paste, or store a real connector credential** (Okta/Google/Entra/Slack/SCIM/scraper/API token or key, service-account JSON) **until the credential vault is implemented + tested + reviewed** per [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md). The confirmation pass (doc 18) confirms connector **existence/status only — never tokens.** Secrets never go in a Postgres column / generated types / client / logs; secret access is a future isolated out-of-request job (never the request DAL, never the browser, never service-role on a request path). RISK-007 is **open** — design ≠ closure.
- **Never run against hosted Supabase.** Local throwaway Postgres only (`scripts/test-rls.sh`).
- **Never mutate hosted Supabase** (no `supabase db push --linked`, no hosted apply, no schema/data change) **unless following [20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) AND explicitly approved by the human** — staging-first, clean tree, expected-migrations-only, verify-after-apply, never on type-drift/duplicate/non-green-RLS. An agent never initiates a hosted apply or production deploy on its own. RISK-001 is **open** — discipline ≠ apply. **⚠️ Staging status (PR #52/#55, evidence in [25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE](./25_STAGING_SCHEMA_AND_STORAGE_APPLY_EVIDENCE.md) §0/§0.2/§0.3):** a **human** has, in **staging** (`ycdpzduxugdsffjqyoai`) only, applied migrations `0001`–`0014`, created the private `contract-files` bucket (`public=false`, 25 MiB, `application/pdf`), **applied the `storage.objects` object policies** (2 `authenticated` INSERT/SELECT; **0 unsafe**), and **run the Storage REST verifier green — the real Storage REST API authorization verification PASSED in hosted staging (14/14, 2026-06-18; real REST calls with user-scoped JWTs, no service-role, no production touched).** **⚠️ Production status (PR #58, evidence [29_PRODUCTION_STORAGE_APPLY_EVIDENCE](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)):** a **human** has since executed the production apply on `dzbfxulvxchdemcettrx` — migrations `0001`–`0014`, the private `contract-files` bucket, 2 `authenticated` policies (0 unsafe) — and **the production Storage REST authorization verification PASSED 14/14** (real REST calls, user-scoped JWTs, no service-role, no secrets); a production-discovered `public.files` `authenticated` SELECT/INSERT grant is codified as migration `0015`. **Production synthetic cleanup is complete (PR #59, [29 §6](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)): synthetic Storage objects (safe path), Auth users, and business rows removed (counts 0); only 2 tenant rows + 3 append-only `audit_logs` rows retained as anchors (`reject_audit_mutation()` blocks audit DELETE).** **The CLI is re-linked back to staging (`ycdpzduxugdsffjqyoai`); the agent ran nothing against production.** Before ANY `--linked` command, **`cat supabase/.temp/project-ref` and confirm the intended ref** — an unintended `--linked` push is a hosted incident. **Both staging AND production Storage authz are now verified; but upload is NOT automatically production-ready** and no upload route/action/UI/signed-URL/AI has shipped. **An agent still never runs hosted mutations** (or the verifiers). **RISK-001 stays OPEN** — closure criteria (1)–(4) are met, but **(5) the [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) cutover checklist is NOT met**; **cutover BLOCKED** until it passes (and the doc 27 parity matrix is mostly missing).
- **Never use service-role keys** outside trusted server/test paths; never in the client.
- **Never weaken RLS**; never filter for security in the client.
- **Never edit a merged migration** (`0001`–`0013`) — fix forward with `000N_*.sql`.
- **Never re-add hard-delete** to core evidence tables (`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`): no `FOR ALL`/`FOR DELETE` policy — write surfaces add `INSERT`+`UPDATE` only (`0004`, [02 §4b](./02_SECURITY_AND_RLS.md)). Archive/soft-delete UI is deferred (not built).
- **New tenant-scoped child/link table** ⇒ add a composite same-tenant FK `(parent_ref, tenant_id) → parent(id, tenant_id)` (and `UNIQUE (id, tenant_id)` on the parent) so cross-tenant references fail at the DB, not just hide under RLS (`0005`, [02 §5b](./02_SECURITY_AND_RLS.md)). Migrations are now `0001`–`0013`.
- **Never build UI ahead of its build-sequence prerequisites** ([06](./06_BUILD_SEQUENCE.md)).
- **Never expand telemetry** — no custom events, no PII/tenant/customer/business data in analytics, no new instrumentation, until a production privacy review ([04 · RISK-013](./04_RISK_REGISTER.md)).
- **Never hosted-apply the local fixture.** `supabase/fixtures/local_demo.sql` is local-only synthetic data; run it only via `bash scripts/seed-local-demo.sh` (throwaway container). Never add it to `supabase/migrations/`, never `supabase db push`, never point it at the linked project ([04 · RISK-015](./04_RISK_REGISTER.md)).
- **Data access goes through `src/lib/data/` (server-only, read-only, RLS-scoped).** Don't scatter raw Supabase queries in pages/components; don't import the DAL into a Client Component; don't pass a caller-supplied `tenant_id` as an authorization input (RLS decides). After any migration, regenerate types: `bash scripts/gen-types-local.sh` (local-only; never `--linked`).
- **Never claim something is verified** without command output.

## Always, every PR
1. Branch off `main`; do not commit to `main`.
2. Run the checks and paste real output:
   ```bash
   bash scripts/check-migration-safety.sh
   bash scripts/test-rls.sh
   bash scripts/check-auth-safety.sh   # if you touched src/
   bash scripts/check-docs-updated.sh
   bash scripts/pr-review-summary.sh
   ```
   For app/UI work also run `npm run lint`, `npm test`, `npx tsc --noEmit`, and `npm run build` —
   all four are now `ci-enforced` on every PR by `.github/workflows/app-ci.yml`. Keep the build
   deterministic: no `next/font/google` (use the system font stack in `globals.css`), no remote fetch at build.
3. Update docs per the [docs-update policy](./08_CODE_AND_DOCS_STANDARD.md#required-updates-per-change-docs-update-policy):
   at minimum add a [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md) entry; touch
   [04_RISK_REGISTER](./04_RISK_REGISTER.md) if risk changed.
4. Self-review against [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md).
5. Apply the [ponytail pass](./08_CODE_AND_DOCS_STANDARD.md#ponytail-pass-before-any-pr) — build the smallest safe thing.

## Connected agent permissions
**Canonical policy for connected coding agents and external tools** (Claude, Vercel, GitHub,
Supabase agents, and any future automation). Other docs link here; do not restate it.

These tools act under the same rules as a human contributor, with a hard ceiling: **they
propose on branches; humans dispose on `main`.** Nothing an agent does reaches `main`,
production, hosted Supabase, secrets, or DNS without human review.

**Allowed**
- Create branches.
- Edit files on branches.
- Open PRs.
- Run local checks (the scripts above; lint/build).
- Read CI / deployment status.
- Vercel may create **preview** deployments.

**Not allowed**
- Push directly to `main`.
- Auto-merge PRs.
- Bypass or disable CI.
- Modify repo secrets / add new secrets.
- Add or use service-role keys (see [non-negotiable rules](#non-negotiable-rules)).
- Run **hosted** Supabase migrations (local-only; hosted apply is a separate reviewed runbook PR).
- Change DNS / custom domains.
- Promote / approve **production** deployments.
- Silently add telemetry, analytics, auth, billing, imports, exports, or integrations **without** docs / risk / changelog updates.

**Required for every agent-generated PR**
- The [PR template](../.github/pull_request_template.md) is completed.
- Docs / risk / changelog updated, or a valid [`.docs-not-needed.md`](../.docs-not-needed.template.md) justification.
- CI is green.
- A human reviews before merge.
- No hosted Supabase changes unless a **deployment-runbook PR** explicitly authorizes them.

Rationale and the automation risk: [04 · RISK-014](./04_RISK_REGISTER.md). Reviewer enforcement: [07 · Connected agent PRs](./07_P0_REVIEW_CHECKLIST.md#connected-agent-permissions). Discipline for vendor/bot PRs: [08](./08_CODE_AND_DOCS_STANDARD.md#vendor-and-bot-agent-prs).

## Current next recommended task
**Legacy UX/workflow parity map is DONE — PR #28** ([14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)).
It is now the **contract that gates cutover**: every parity-bound PR must preserve the legacy user workflow (or get the difference
approved + documented there), and **cutover is blocked on workflow parity, not backend/RLS readiness**. Before claiming **Same** for any
workflow, inspect the running legacy app for exact fields/labels/filters/exports (doc 14 §9 — `needs legacy inspection`; do not invent).

**Contract audit-on-write is DONE — PR #29** (`0010`; DB-side `SECURITY DEFINER` `AFTER INSERT/UPDATE` trigger; T31/T32).
**Contract write PATH is DONE — PR #30** (server-side DAL + `"use server"` actions, anon client, RLS-gated, `tenant_id` server-resolved, audit inherited).
**Contract create/edit UI is DONE — PR #31** (`/contracts/new` + `/contracts/[id]/edit` posting to the #30 actions; RLS is the boundary, not client role checks).
**Contract form parity fields are DONE — PR #32** (`0011` adds `category`/`procurement_date`/`notes`/`po_number`/`auto_renew`/`month_to_month`; +7 unit tests; RLS unchanged by that PR). **Partial** legacy parity still ([15](./15_LEGACY_CONTRACT_FORM_INSPECTION.md)).
**Contract PDF/AI extraction is DESIGNED — PR #33** (security/design plan [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md); **nothing built** — no upload, Storage, AI call, `files` surface, or migration).
**The recommended next step is to IMPLEMENT the PDF/AI design (multiple PRs, each with tests), then the remaining parity gaps** —
every parity-bound step must inspect the running legacy app first (doc 14 §9 — `needs legacy inspection`; do not invent):
1. ~~**Contract audit-on-write**~~ — **DONE (PR #29, `0010`).** Invisible backend; no user-visible workflow changed.
2. ~~**Contract write path**~~ — **DONE (PR #30).** Server actions + DAL on the anon client; RLS is the boundary; `paying_org_id` never grants write; no `DELETE`/`FOR ALL`; no service-role; audit inherited.
3. ~~**Contract create/edit UI**~~ — **DONE (PR #31).** First user-visible write workflow; RLS-gated; generic denial (no enumeration); no delete/archive button.
4. ~~**Contract form parity fields**~~ — **DONE (PR #32, `0011`).** Added the schema-backed legacy fields. `commodity_*`/`validated` deliberately not added (hidden / read-only in legacy — docs/15).
5. ~~**Contract PDF/AI extraction DESIGN**~~ — **DONE (PR #33, [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)).** Design only — legacy anti-patterns documented (service-role Storage fn, no prompt-injection defense, wholesale AI fields, auto-overwrite); v3 plan = assistive upload → server-validated, tenant-bound, signed-URL Storage → AI **suggestions only**, strict-allowlist parsed by `parseContractWriteInput` → user reviews+applies → save via the PR #30 RLS-gated action.
6. ~~**`files` metadata foundation**~~ — **DONE (PR #34, `0012`).** Additive `files` columns (`contract_id` same-tenant FK + `storage_bucket`/`content_type`/`byte_size`/`sha256`/`upload_status`/`scan_status`/`extraction_status`/`extraction_result_json`/`extraction_error`/`updated_at`) + CHECKs + indexes. **No RLS policy, no Storage/upload/AI/UI** — `files` stays default-deny / not surfaced. RLS suite 177 → **186** (T33). `gen-types` updated.
7. ~~**`files` RLS policies + §5 tests**~~ — **DONE (PR #35, `0013`).** SELECT `is_tenant_member` (tenant-member read; org-scoped deferred) + INSERT contract-write authority (`can_write_contract`: tenant editor+ OR procurement-org manager; **`paying_org` no write**; `uploaded_by`=caller); **no UPDATE/DELETE/FOR ALL**. T34 (+ T27/T33 updated); RLS suite 186 → **205**. `files` authorized-by-design + tested, still **not surfaced**.
8. ~~**OMC production replacement parity gate**~~ — **DONE (PR #36, docs-only — [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)).** Created the binding go/no-go gate (grounded ~105-row replacement matrix, hard-blocker list, go/no-go checklist, OMC-confirmation list, honest ~70–110-PR estimate). **OMC = paying production replacement, NOT a pilot.** No migration/RLS/app/route change; RLS stays 205.
9. ~~**OMC confirmation pass scaffolding**~~ — **DONE (PR #37, docs-only — [18](./18_OMC_CONFIRMATION_PASS.md)).** The working questionnaire + workshop agenda + workflow confirmation table + decision log that resolves doc 17's `probably`/`unknown` rows from OMC evidence. **Feeds doc 17; does NOT make v3 ready; does NOT remove blockers by itself.** Unknown = blocker until confirmed (owner + date + evidence). **No secrets/tokens collected.** RLS stays 205.
10. **The canonical next-PR sequence is [17 §7](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)** — two interleaved tracks: **A** = security/file path (server-side PDF **validation + storage-path helpers DONE PR #40** — `src/lib/files/pdf-validation.ts`; → the hosted private `contract-files` bucket + Storage object policies + the upload action [**user-scoped client + the `0013` insert authority; NO service-role app route**] → signed-URL read → extraction worker [out-of-request, tenant-re-deriving] + strict-allowlist parsing → review-and-apply UI → file/extraction audit → org-scoped `files` read), **B** = replacement-parity build-out (OPS hosted-apply gate, admin/auth, apps, connectors+credential vault, licenses/spend, people/identity, reports, billing). **First run the OMC-confirmation pass via [18_OMC_CONFIRMATION_PASS](./18_OMC_CONFIRMATION_PASS.md) — it sizes everything; record confirmations there, then update doc 17.** The Storage bucket + object-RLS are hosted-gated ([20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)) — **PR #41 ([21](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md)) empirically proved the local harness has no `storage` schema and object-RLS can't be faithfully tested locally; don't add a `storage` shim or a storage-policy migration (breaks `test-rls.sh`/`gen-types`). Verify the bucket/policies in hosted staging via the [21 §6](./21_STORAGE_LOCAL_HARNESS_FEASIBILITY.md) checklist before any upload action ships — the exact reviewed, human-executed staging apply runbook is [22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) (staging-only, stop before prod, nothing auto-applied), and the evidence template to fill in during that execution is [23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md); the staging env-var inventory + Vercel/Supabase wiring checklist (names only, no values) is [24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST](./24_STAGING_ENVIRONMENT_VARIABLES_AND_WIRING_CHECKLIST.md). An agent NEVER executes a hosted apply / `supabase db push --linked` / bucket-or-policy creation / Vercel-or-Supabase env config itself — those are human-run under explicit approval (doc 20); an agent may only prepare the runbook/evidence/inventory docs (never with real secrets/values).** **Suggestions only — no AI auto-save; PDF text + AI output are untrusted.**
Alternative tracks (lower priority): the first reviewed **hosted-Supabase apply** (RISK-001); or an identity surface —
- **Richer "managed vs orphaned" status** (needs a tenant-only column): build it via a **`security_invoker` view** (caller RLS scopes it) — or a `SECURITY DEFINER` fn that re-derives scope — returning only a status enum; **NEVER** read `people`/`identity_accounts` rows into an org surface. Follow doc 12 §4 (the definer trap) + §7.7 (exact readable-only count test).

Do NOT org-scope `people` or `identity_accounts` — no app anchor; org-scoping them leaks the tenant-wide HR/IdP directory (doc 12 §4/§6). `people` stays **tenant-only**; `identity_accounts` stays **default-deny**.
Any account-intelligence work derives ONLY from visible `app_users` + visible matches (PR #24 pattern) — never read `people`/`identity` into an org surface, and do NOT relabel "unmatched/stale candidate" as "orphaned/deactivated/managed/UAR".
Still NOT safe to surface: `people`, `identity_accounts`, `invoices`/`files`/`license_*`. No identity matching algorithm / merge / UAR / orphaned status / provisioning exists yet.
(Stages 4/4b apps — PR #13/#14; Stage 5 contracts — PR #19; Stage 5b linked panels — PR #20; Stage 6a app-user roster — PR #21; Stage 6b identity read-scope design — PR #22; Stage 6c match status — PR #23; Stage 6d account summary — PR #24; Stage 5b contract write design — PR #25; truth pass — PR #26; `0009` app_contracts tenant-bind — PR #27; legacy UX/workflow parity map — PR #28; contract audit-on-write `0010` — PR #29; contract write path/DAL + server actions — PR #30; contract create/edit UI — PR #31; contract form parity fields `0011` — PR #32; contract PDF/AI extraction design — PR #33; files metadata foundation `0012` — PR #34; files RLS policies `0013` — PR #35; OMC production replacement parity gate doc 17 — PR #36; OMC confirmation pass scaffolding doc 18 — PR #37; connector credential vault design doc 19 — PR #38; staging + hosted apply & cutover discipline doc 20 — PR #39; contract-file PDF validation foundation `src/lib/files/pdf-validation.ts` — PR #40.)

## Current open risks to respect
**hosted apply PARTIAL** (`0001`–`0013` `staged` to staging `ycdpzduxugdsffjqyoai`; Storage object policies + verification + production still pending — RISK-001 OPEN, [04](./04_RISK_REGISTER.md)); child tables **not org-scoped for reads** — tenant-only (`people`) or default-deny (`identity_accounts`/`license_*`/`files`/`invoices`); `app_contracts` (`0006`) + `app_users` (`0007`) + `app_user_identity_matches` (`0008`) are now org-scoped read; see read map [02 §8](./02_SECURITY_AND_RLS.md) (RISK-002, narrowed not closed); no tenant switching /
user provisioning yet (RISK-012); no credential vault; imports/exports destructive-in-legacy
(don't port — legacy deletes "outdated" users, `onFileLinkedToApp.js:290`); v3 must not miss legacy
paid-client (OMC/Flywheel) capabilities (RISK-016). Full list:
[04_RISK_REGISTER](./04_RISK_REGISTER.md).

## Legacy parity (paid client)
When you build a product surface, update its row in [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md)
(status + OMC checklist) and link the PR. Verify legacy behavior from the legacy repo
(`/Users/samvemuri/Desktop/IDCaddie_Repo-main`) and [current-product-map.md](./current-product-map.md) —
never from memory; mark unverified claims `needs-verification`. Do **not** imply OMC can cut over until P0/P1 parity is verified.

## How to summarize at the end of a PR
State: what changed, what you **verified** (with the command output), what is still
unverified/deferred, which docs/risk/changelog you updated, and the next safe step. Do not
overstate. Surface uncertainty explicitly.

## How to avoid hidden context
If a fact matters, put it in a doc, test, script, CI check, the risk register, or the
changelog — **not** in chat or memory. The next agent should need nothing but the repo.
