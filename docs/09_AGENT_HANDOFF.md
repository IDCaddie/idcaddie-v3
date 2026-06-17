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
Migrations `0001`–`0013` are `implemented`, `verified-local`, `ci-enforced`, **not hosted-applied**
(`org_rls_test.sql` = 205 assertions, T1–T34; 51 vitest tests). Auth/session skeleton, read-only
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
- **Never run against hosted Supabase.** Local throwaway Postgres only (`scripts/test-rls.sh`).
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
8. **Implement PDF/AI (remaining steps)** ← **next** — per [16 §10](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md), in order, each its own PR with tests: **private Storage bucket + server-side validation/scan gate (docs/16 §3)** → extraction worker (**out-of-request, tenant-re-deriving; NO service-role app route**) with strict-allowlist parsing → minimal review-and-apply UI → DB-side file/extraction audit; plus the deferred **org-scoped `files` read** broadening. **Suggestions only — no AI auto-save; PDF text + AI output are untrusted.** Then the renewal **gantt** / list-page inline-edit, and app-contract link/unlink (doc 14 §8).
Alternative tracks (lower priority): the first reviewed **hosted-Supabase apply** (RISK-001); or an identity surface —
- **Richer "managed vs orphaned" status** (needs a tenant-only column): build it via a **`security_invoker` view** (caller RLS scopes it) — or a `SECURITY DEFINER` fn that re-derives scope — returning only a status enum; **NEVER** read `people`/`identity_accounts` rows into an org surface. Follow doc 12 §4 (the definer trap) + §7.7 (exact readable-only count test).

Do NOT org-scope `people` or `identity_accounts` — no app anchor; org-scoping them leaks the tenant-wide HR/IdP directory (doc 12 §4/§6). `people` stays **tenant-only**; `identity_accounts` stays **default-deny**.
Any account-intelligence work derives ONLY from visible `app_users` + visible matches (PR #24 pattern) — never read `people`/`identity` into an org surface, and do NOT relabel "unmatched/stale candidate" as "orphaned/deactivated/managed/UAR".
Still NOT safe to surface: `people`, `identity_accounts`, `invoices`/`files`/`license_*`. No identity matching algorithm / merge / UAR / orphaned status / provisioning exists yet.
(Stages 4/4b apps — PR #13/#14; Stage 5 contracts — PR #19; Stage 5b linked panels — PR #20; Stage 6a app-user roster — PR #21; Stage 6b identity read-scope design — PR #22; Stage 6c match status — PR #23; Stage 6d account summary — PR #24; Stage 5b contract write design — PR #25; truth pass — PR #26; `0009` app_contracts tenant-bind — PR #27; legacy UX/workflow parity map — PR #28; contract audit-on-write `0010` — PR #29; contract write path/DAL + server actions — PR #30; contract create/edit UI — PR #31; contract form parity fields `0011` — PR #32; contract PDF/AI extraction design — PR #33; files metadata foundation `0012` — PR #34; files RLS policies `0013` — PR #35.)

## Current open risks to respect
`not-hosted-applied`; child tables **not org-scoped for reads** — tenant-only (`people`) or default-deny (`identity_accounts`/`license_*`/`files`/`invoices`); `app_contracts` (`0006`) + `app_users` (`0007`) + `app_user_identity_matches` (`0008`) are now org-scoped read; see read map [02 §8](./02_SECURITY_AND_RLS.md) (RISK-002, narrowed not closed); no tenant switching /
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
