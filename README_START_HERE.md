# START HERE — ID Caddie v3

True entry point for this repo. It links to the canonical docs; it does **not**
restate them (so it can't go stale). Full index + reading paths:
[`docs/10_DOCS_INDEX.md`](docs/10_DOCS_INDEX.md).

## What this is
A from-scratch, secure rebuild of ID Caddie — the enterprise source of truth for
*what apps a company uses, who owns/pays/renews each, who has access, and what
charges back to which org*. Built on Supabase/Postgres with **RLS as the
authorization source of truth**. We preserve validated workflows and port **no**
Firebase code.

## Current status (one line)
**Read-only governance foundation + first contract write workflow on the RLS foundation.**
On the tested, CI-enforced schema + RLS + auth/session foundation, **read-only product surfaces**
now ship (`/apps` and `/contracts` lists + detail pages), and the **first user-visible write
workflow** — RLS-gated, audited contract create/edit — exists. **Connector / credential-vault work
is ongoing**, and **OMC/Flywheel cutover remains blocked** (RISK-001/RISK-007 open, not
production-ready). Authoritative status: [`docs/00_PRODUCT_STATUS.md`](docs/00_PRODUCT_STATUS.md).

## Non-negotiables (apply to every change)
- Do **not** run against hosted Supabase — local-first only.
- Do **not** use service-role keys outside approved server/test paths.
- Do **not** rely on frontend filtering for authorization — RLS decides.
- Do **not** weaken RLS or edit a merged migration — fix forward.
- Do **not** build UI ahead of the foundation it depends on.
- **Telemetry:** Vercel preview/platform telemetry (Web Analytics + Speed Insights) exists, platform-only. Do **not** add production/custom domains yet, add custom events, or treat platform telemetry as an audit/product source of truth ([04 · RISK-013](docs/04_RISK_REGISTER.md)).
- Every PR updates docs / risk / changelog, or justifies why not.

## Connected agent permissions
Connected coding agents and tools (Claude/Vercel/GitHub/Supabase) **propose on branches; humans
dispose on `main`.** Agents may branch, edit, open PRs, run local checks, read CI/deploy status,
and create Vercel **preview** deployments. They may **not** push to `main`, auto-merge, bypass CI,
touch secrets/service-role keys, run hosted Supabase migrations, change DNS/custom domains, promote
production, or silently add telemetry/auth/billing/imports/exports/integrations. Every agent PR
needs a completed template, docs/risk/changelog updates, green CI, and **human review before
merge**. Full policy: [09 · Connected agent permissions](docs/09_AGENT_HANDOFF.md#connected-agent-permissions).

## Required checks before any PR
```bash
bash scripts/check-migration-safety.sh selftest   # the checker checks itself
bash scripts/check-migration-safety.sh            # migration numbering + unsafe-keyword lint
bash scripts/test-rls.sh                           # apply ALL migrations to throwaway Postgres + run RLS suite (needs Docker)
bash scripts/check-auth-safety.sh                  # src/ has no service-role/hardcoded keys/client-side role storage
bash scripts/check-docs-updated.sh                 # docs-drift gate
bash scripts/pr-review-summary.sh                  # categorize the diff + reviewer focus
```
For app/UI changes also run `npm run lint`, `npm test`, `npx tsc --noEmit`, and `npm run build`.
All of these run in CI on every PR (`.github/workflows/`): `app-ci.yml` gates lint/test/typecheck/build,
`rls-tests.yml` runs the RLS suite, and `migration-safety.yml` / `review-discipline.yml` cover migrations + docs.

## Local demo data
```bash
bash scripts/seed-local-demo.sh          # load a synthetic Demo Tenant into a throwaway local DB (verify + tear down)
bash scripts/seed-local-demo.sh --keep   # leave the local DB up on 127.0.0.1:55432 to poke with psql
```
Local-only, hosted-proof, all-synthetic data. **Never** hosted-apply the fixture
(`supabase/fixtures/local_demo.sql` is not a migration) — see [03](docs/03_DATABASE_AND_MIGRATIONS.md#localdemo-fixture-not-a-migration).

Regenerate the typed `Database` after a migration (local-only, hosted-proof):
```bash
bash scripts/gen-types-local.sh          # → src/lib/database.types.ts (throwaway DB; never --linked)
```

## Quick starts
- **Reviewer (Mike/Jon):** [00 Product Status](docs/00_PRODUCT_STATUS.md) → [04 Risk Register](docs/04_RISK_REGISTER.md) → [05 Changelog](docs/05_ENGINEERING_CHANGELOG.md).
- **Security reviewer:** [02 Security & RLS](docs/02_SECURITY_AND_RLS.md) → `supabase/tests/org_rls_test.sql` → [04 Risk Register](docs/04_RISK_REGISTER.md) → [07 P0 Checklist](docs/07_P0_REVIEW_CHECKLIST.md).
- **New engineer:** this file → [00](docs/00_PRODUCT_STATUS.md) → [01 Architecture](docs/01_ARCHITECTURE.md) → [03 Database & Migrations](docs/03_DATABASE_AND_MIGRATIONS.md) → [06 Build Sequence](docs/06_BUILD_SEQUENCE.md) → [08 Code & Docs Standard](docs/08_CODE_AND_DOCS_STANDARD.md).
- **Coding agent:** [09 Agent Handoff](docs/09_AGENT_HANDOFF.md) → [00](docs/00_PRODUCT_STATUS.md) → [06](docs/06_BUILD_SEQUENCE.md) → [07](docs/07_P0_REVIEW_CHECKLIST.md).
- **Database reviewer:** [03](docs/03_DATABASE_AND_MIGRATIONS.md) → [`docs/v3-data-model.md`](docs/v3-data-model.md) → `supabase/migrations/` → [`docs/migration-workflow.md`](docs/migration-workflow.md).

## Living-docs rule
Docs, the [risk register](docs/04_RISK_REGISTER.md), and the
[changelog](docs/05_ENGINEERING_CHANGELOG.md) are part of every change. The PR
template and `scripts/check-docs-updated.sh` enforce it; the only opt-out is a
filled-in `.docs-not-needed.md` (template: [`.docs-not-needed.template.md`](.docs-not-needed.template.md)).
