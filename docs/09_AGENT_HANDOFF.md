# 09 · Agent Handoff

**Canonical source for: how a coding agent (Claude/Codex/etc.) safely continues work.**
Read this + [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) before doing anything. Repo rules
also live in `AGENTS.md` / `claude/CLAUDE.md`.

## Current repo state (verify before trusting — see [00](./00_PRODUCT_STATUS.md))
Phase 2 — auth + tenant/org context, built on the data/RLS foundation. Migrations `0001`–`0003`
are `implemented`, `verified-local`, `ci-enforced`, **not hosted-applied**. The auth skeleton
(login, server session via `src/proxy.ts`, protected `(authenticated)/` group) **and read-only
tenant/org context resolution** (`src/lib/auth/tenant-context.ts`, shown in the protected shell)
are built but **not exercised against hosted Supabase**. No tenant switching, no provisioning, no
product UI. Vercel **Web Analytics + Speed Insights** are present (platform telemetry only, bare
components, no custom events). Legacy Firebase is still production. Don't trust any prompt's
"seeded" history — re-verify from `git log`, `gh pr list`, `ls supabase/migrations`, and the source/test files.

## Non-negotiable rules
- **Never run against hosted Supabase.** Local throwaway Postgres only (`scripts/test-rls.sh`).
- **Never use service-role keys** outside trusted server/test paths; never in the client.
- **Never weaken RLS**; never filter for security in the client.
- **Never edit a merged migration** (`0001`–`0005`) — fix forward with `000N_*.sql`.
- **Never re-add hard-delete** to core evidence tables (`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`): no `FOR ALL`/`FOR DELETE` policy — write surfaces add `INSERT`+`UPDATE` only (`0004`, [02 §4b](./02_SECURITY_AND_RLS.md)). Archive/soft-delete UI is deferred (not built).
- **New tenant-scoped child/link table** ⇒ add a composite same-tenant FK `(parent_ref, tenant_id) → parent(id, tenant_id)` (and `UNIQUE (id, tenant_id)` on the parent) so cross-tenant references fail at the DB, not just hide under RLS (`0005`, [02 §5b](./02_SECURITY_AND_RLS.md)). Migrations are now `0001`–`0005`.
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
**Identity/matching read-scope DESIGN is DONE — PR #22** (docs only — [12_IDENTITY_MATCHING_READ_SCOPE](./12_IDENTITY_MATCHING_READ_SCOPE.md)).
Nothing was built/policy-changed; the design decides the safe future read model. RISK-002 still **narrowed, not closed**.

Next safe step — pick one; obey doc 12 for anything identity-related:
- **(a) Contracts steward writes:** `INSERT`/`UPDATE` only, **never `DELETE`/`FOR ALL`** (PR #16 / `0004`), steward-org gated, audited.
- **(b) Matched/unmatched per app_user (follow [doc 12](./12_IDENTITY_MATCHING_READ_SCOPE.md)):** add ONE org-scoped `SELECT` on `app_user_identity_matches` gated on a **readable `app_user`** (mirror `0007`, explicit tenant-bind, SELECT-only, no DELETE; doc 12 §5). Land doc 12 §7 tests **before** any UI. Show match *status*, not person PII.

Do NOT org-scope `people` or `identity_accounts` — no app anchor; org-scoping them leaks the tenant-wide HR/IdP directory (doc 12 §4/§6). `people` stays **tenant-only**; `identity_accounts` stays **default-deny**.
Still NOT safe to surface: `people`, `identity_accounts`, `app_user_identity_matches`, `invoices`/`files`/`license_*`.
No identity matching / UAR / license eval / provisioning exists yet.
(Stages 4/4b apps — PR #13/#14; Stage 5 contracts — PR #19; Stage 5b linked panels — PR #20; Stage 6a app-user roster — PR #21; Stage 6b identity read-scope design — PR #22.)

## Current open risks to respect
`not-hosted-applied`; child tables **not org-scoped for reads** — tenant-only (`people`) or default-deny (`identity_accounts`/`app_user_identity_matches`/`license_*`/`files`/`invoices`); `app_contracts` (`0006`/PR #20) + `app_users` (`0007`/PR #21) are now org-scoped read; see read map [02 §8](./02_SECURITY_AND_RLS.md) (RISK-002, narrowed not closed); no tenant switching /
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
