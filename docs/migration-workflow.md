# Supabase Migration Workflow & Discipline

Authorization for ID Caddie v3 lives in Postgres (RLS), so migrations are
security-critical. These rules make it hard to accidentally skip local testing,
mutate a merged migration, or push to hosted Supabase too early.

## Golden rules

1. **Local first.** All schema/RLS work is developed and tested against a local
   throwaway Postgres. Never develop against hosted/staging Supabase.
2. **Test before every DB PR.** Run both checks locally and make sure they pass:
   ```bash
   bash scripts/check-migration-safety.sh   # static: numbering + unsafe keywords
   bash scripts/test-rls.sh                  # applies all migrations + runs RLS assertions
   ```
   CI runs the same two scripts on every PR (`.github/workflows/`).
3. **Migrations are append-only.** Add a new numbered file
   (`NNNN_description.sql`); never edit an already-merged migration. Reasons:
   - Other clones/branches and (eventually) hosted environments have already run it.
   - Rewriting history makes "what is actually deployed" unknowable.
   - **Only exception:** before the *first* hosted/staging apply, a merged
     migration may be amended — but only with **explicit written approval** from
     the repo owner, recorded in the PR. After the first hosted apply, this
     exception is gone: fix forward with a new migration.
4. **RLS may only be strengthened, never weakened,** in a migration without an
   explicit, reviewed `-- safety-ack:` note explaining why (see below).
5. **Hosted apply is a separate, reviewed step.** Merging a migration PR does
   **not** deploy it. Applying migrations to hosted Supabase is its own change,
   performed by an authorized person against a named environment, reviewed
   independently. Local PRs never carry hosted credentials or service-role keys.

## Adding a migration

1. Create the next sequential file: `supabase/migrations/000N_short_description.sql`.
   Keep it additive (`create ...`, `alter ... add`, `create policy`, `create or
   replace`). To replace a policy/trigger, `drop ... if exists` then recreate in
   the same file — don't edit the file that first created it.
2. Add or extend assertions in `supabase/tests/*_test.sql` — **every** RLS change
   needs at least one authorization test (positive and negative).
3. Fill in the [migration checklist](./migration-checklist.md) in your PR.
4. Run `scripts/check-migration-safety.sh` and `scripts/test-rls.sh`; paste the
   results into the PR.

## Unsafe operations

`scripts/check-migration-safety.sh` flags `DROP TABLE`, `TRUNCATE`, and
`DISABLE ROW LEVEL SECURITY`. If one is genuinely required, add a note in the
migration file and it will pass:

```sql
-- safety-ack: dropping legacy staging table X, empty in all environments, approved by <name>
drop table public.legacy_staging;
```

The note forces a human to state *why* it is safe; reviewers should treat any
`safety-ack` as a stop-and-read.

## What gets enforced where

| Concern | Enforced by |
|---|---|
| Sequential numbering, no dup numbers, unsafe keywords | `scripts/check-migration-safety.sh` (+ CI) |
| Migrations apply cleanly + RLS assertions hold | `scripts/test-rls.sh` (+ CI) |
| No edits to merged migrations, hosted-apply approval | this doc + PR review (human) |
| Tenant isolation, exact-org writes, audit immutability | the migrations themselves (RLS) |
