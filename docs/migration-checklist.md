# Migration PR Checklist

Copy this into the description of any PR that adds or changes a migration.
See [migration-workflow.md](./migration-workflow.md) for the rules.

```markdown
### Migration checklist

- **New migration file:** `supabase/migrations/000N_<description>.sql`
  (next sequential number; no existing migration edited)
- **Reason:** <what this migration does and why it's needed>
- **RLS impact:** <new/changed policies; does it strengthen or change access?
  confirm it does NOT weaken RLS, or link the `-- safety-ack:` note>
- **Tests added/updated:** `supabase/tests/*_test.sql`
  (at least one positive + one negative authorization assertion)
- **Local test results (paste output):**
  - `bash scripts/check-migration-safety.sh` → <pass/fail>
  - `bash scripts/test-rls.sh` → <pass/fail; "ALL ORG-RLS ASSERTIONS PASSED">
- **Unsafe keywords (DROP TABLE / TRUNCATE / DISABLE RLS):** <none / listed with
  `safety-ack` reason + approver>
- **Rollback / forward-fix plan:** <how to recover if this is wrong — normally a
  new forward-fix migration, since merged migrations are not edited>
- **Editing a merged migration?** <no / yes — requires pre-first-hosted-apply +
  explicit owner approval, linked here>
- **Hosted apply status:** not applied / applied to <env> on <date> by <name>
  (hosted apply is a separate reviewed step — not done by merging this PR)
```
