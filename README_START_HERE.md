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
**Phase 2 — auth/session skeleton on the RLS foundation.** Schema + RLS are tested
locally and CI-enforced; an auth skeleton (login, server session, protected routes) is
built but **not exercised against hosted Supabase**, tenant/org context is a placeholder,
and there is **no product UI yet**. Authoritative status: [`docs/00_PRODUCT_STATUS.md`](docs/00_PRODUCT_STATUS.md).

## Non-negotiables (apply to every change)
- Do **not** run against hosted Supabase — local-first only.
- Do **not** use service-role keys outside approved server/test paths.
- Do **not** rely on frontend filtering for authorization — RLS decides.
- Do **not** weaken RLS or edit a merged migration — fix forward.
- Do **not** build UI ahead of the foundation it depends on.
- **Telemetry:** Vercel preview/platform telemetry (Web Analytics + Speed Insights) exists, platform-only. Do **not** add production/custom domains yet, add custom events, or treat platform telemetry as an audit/product source of truth ([04 · RISK-013](docs/04_RISK_REGISTER.md)).
- Every PR updates docs / risk / changelog, or justifies why not.

## Required checks before any PR
```bash
bash scripts/check-migration-safety.sh selftest   # the checker checks itself
bash scripts/check-migration-safety.sh            # migration numbering + unsafe-keyword lint
bash scripts/test-rls.sh                           # apply ALL migrations to throwaway Postgres + run RLS suite (needs Docker)
bash scripts/check-auth-safety.sh                  # src/ has no service-role/hardcoded keys/client-side role storage
bash scripts/check-docs-updated.sh                 # docs-drift gate
bash scripts/pr-review-summary.sh                  # categorize the diff + reviewer focus
```
For app/UI changes also run `npm run lint` and `npm run build`.
All of these also run in CI on every PR (`.github/workflows/`).

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
