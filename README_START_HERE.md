# ID Caddie v3 Start Pack

This pack is the starting point for rebuilding ID Caddie as a clean Supabase/Postgres enterprise SaaS app.

## Rule of the rebuild
Do not port Firebase code directly. Preserve validated workflows and rebuild the data/security foundation.

## Recommended first move
1. Create a new repo named `idcaddie-v3`.
2. Copy this pack into the repo.
3. Paste `claude/prompts/01_repo_extraction.md` into Claude Code while it has access to the legacy repo.
4. Do not let Claude write app code until it has produced the product map, data model, and security model.

## Target stack
- Next.js App Router
- Supabase Auth
- Supabase Postgres
- Postgres RLS on every tenant-scoped table
- Supabase Storage for files
- Vercel hosting
- Playwright browser tests
- SQL/RLS integration tests

## First milestone
A secure Omnicom/Flywheel source-of-truth MVP:
- login
- organizations/agencies
- apps
- contracts
- app-contract linking
- people/app users import
- unmanaged users report
- stale users report
- audit log

## Developer workflow (database changes)

Authorization lives in Postgres RLS, so the database is developed and tested
**locally first** — never against hosted Supabase, and never with service-role keys.
Full rules: [`docs/migration-workflow.md`](docs/migration-workflow.md).

For any schema/RLS change:

1. Add the next sequential migration `supabase/migrations/000N_<description>.sql`.
   **Never edit an already-merged migration** — fix forward with a new one.
2. Add/extend authorization assertions in `supabase/tests/*_test.sql`
   (at least one positive and one negative).
3. Run both checks locally before opening the PR:
   ```bash
   bash scripts/check-migration-safety.sh   # numbering + unsafe-keyword lint
   bash scripts/test-rls.sh                  # apply all migrations + run RLS assertions
   ```
4. Fill in [`docs/migration-checklist.md`](docs/migration-checklist.md) in the PR.

CI runs both scripts on every pull request (`.github/workflows/`). Both use a
throwaway `postgres:16` Docker container with a Supabase-style `auth` shim — no
hosted Supabase, no service-role keys. Applying migrations to a hosted environment
is a **separate, reviewed deployment step**, not part of merging a PR.

See `supabase/tests/rls_test_plan.md` for test details.
