# GWS-E4a — apply migration 0092 to hosted staging

**This package authorizes nothing.** It is the bounded procedure for one apply, to one project, of one migration.

| | |
|---|---|
| Target | hosted **staging**, project `ycdpzduxugdsffjqyoai` |
| Migration | `supabase/migrations/0092_google_workspace_connector_validation.sql` |
| SHA256 | `4780cf67598543a053058d90900bc169afff75f35ccdc3dd696c24a550c19eaa` |
| Reviewed as | idcaddie-v3 **#445**, merged `408dd2b` |
| Scope | additive DDL + GRANT/REVOKE. One table, one function, one index. |

## What it does NOT do

No connector row is created. No lifecycle state is advanced. No run is opened. No AWS or Google operation occurs.
0092 is DDL: it makes `configured → verified` *earnable* by `connector_runner`; it earns nothing itself.

## Preconditions (the apply script re-checks every one against the database and refuses if any fails)

1. `IDCADDIE_APPLY_0092_CONFIRM` set to the exact confirm phrase.
2. The migration file's SHA256 equals the pin above.
3. Linked project is the staging ref; `SUPABASE_DB_URL` names staging and **not** the production ref.
4. `0086` is applied (GWS-E4) and `0092` is **not**.
5. Remote chain head is `0091` — nothing applied out of order.
6. `0092` is the only pending migration.

## Run

```bash
export SUPABASE_DB_URL='postgresql://...'          # operator's own credential; never stored, never echoed
IDCADDIE_APPLY_0092_CONFIRM='APPLY 0092 GOOGLE WORKSPACE VALIDATION STAGING' \
  bash scripts/gws-0092/apply.sh

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/gws-0092/verify.sql
```

**The apply is not complete until `verify.sql` prints `GWS-0092 POST-APPLY PROOF PASSED`.**

## Failure and recovery

**0092 is one `begin; … commit;`.** A failure at any statement rolls the entire migration back and the CLI does not
record the version. There is no partial state to clean up.

| Symptom | Meaning | Action |
|---|---|---|
| `REFUSED: …` before the apply line | A precondition failed. Nothing was sent. | Fix the named precondition and re-run. Never bypass a gate. |
| Migration errors mid-apply | Whole transaction rolled back; ledger unchanged. | Re-run after fixing. Confirm with `select count(*) from supabase_migrations.schema_migrations where version='0092'` → `0`. |
| Apply succeeds, baseline delta fails | Row counts moved across the apply — 0092 is pure DDL, so something else wrote concurrently. | Do **not** proceed. Investigate the concurrent writer before running anything downstream. |
| Apply succeeds, `verify.sql` fails | Objects landed but a guarantee is wrong. | Do **not** hand-fix with `GRANT`/`REVOKE`/`ALTER` — that drifts the database from the file and the next environment reproduces the defect. Author a follow-up migration, review it, apply it. |
| Need to undo an applied 0092 | — | A new reviewed migration that drops the function and table, never a manual `DROP`. Nothing depends on 0092 until the recording entrypoint runs, so an undo is cheap while `google_workspace_connector_validations` is empty. |

## Next step after success

**Not** the connector row. The order is fixed and each step gates the next:

1. **GWS-E1** — a usable Google signing key: enabled, reviewed three-statement policy, and the
   `alias/idcaddie-staging-google-workspace-signing` alias. Note the existing key
   `380fae27-dc4d-45a8-80e8-2e931809a21b` is `PendingDeletion` with deletion on **2026-09-12**.
2. **GWS-E1 (principal)** — create `idcaddie-staging-google-workspace-task` and grant `kms:Sign` on exactly that key ARN.
3. **GWS-E2** — domain-wide delegation for exactly the four approved scopes.
4. Fill and register the four Google task definitions.
5. **Run `verify`** — DB-free, no connector row, token discarded.
6. **Create the connector row** at `configured` (`docs/GOOGLE_WORKSPACE_CONNECTOR_ROW_RUNBOOK.md`).
7. **Run `verify-record`** — earns `verified`. This is GWS-E3.
8. `aggregate`, then `persist`.

## How this package was validated

`verify.sql` was run against a throwaway local Postgres with all 92 migrations applied (`scripts/test-rls.sh`), and
against six mutations of the migration chain. It caught: the start-state gate removed, the
success-requires-evidence CHECK dropped, `runner_advance_connection_state` widened to authorize
`configured → verified`, and the recording function no longer writing `verified`.

Two mutations it could **not** catch locally — the function granted to `authenticated`, and the evidence table's
deny-all removed — are masked by the local harness, which blanket-grants every table and function and then re-revokes a
named set. That masking does not exist on hosted, where `verify.sql`'s `A4` assertions are live; and in CI the same two
properties are held by `scripts/google-workspace-validation-boundary-migration.test.ts` reading the migration text.
This is the same masking class documented for 0016, 0076, 0079 and 0085.

One assertion was deliberately **not** written: that `service_role` cannot read the evidence table. It holds table
access across this schema by Supabase's default privileges, and 0092 follows the established deny-all set
(`public, anon, authenticated, connector_runner`) used by 0076 and 0085 rather than inventing a different one. What
0092 does guarantee — and `A4` does assert — is that `service_role` cannot **execute** the recording function, so it
cannot earn `verified` through the sanctioned path.
