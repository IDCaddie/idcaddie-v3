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

## Running the RLS tests
Authorization lives in Postgres RLS, so it is tested directly against Postgres
(not the app). Run the full suite locally with Docker:

```bash
bash scripts/test-rls.sh
```

It applies every `supabase/migrations/*.sql` to a throwaway `postgres:16` container
(with a Supabase-style `auth` shim), then runs `supabase/tests/*_test.sql` and fails
on any assertion error. The same script runs in CI on every pull request
(`.github/workflows/rls-tests.yml`). No hosted Supabase, no service-role keys.
See `supabase/tests/rls_test_plan.md` for details.
