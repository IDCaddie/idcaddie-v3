# 03 · Database & Migrations

**Canonical source for: migration list + database/migration workflow.** The detailed
process and PR template already exist and are CI-tied — this doc is the entry point and
links them rather than restating:
- Process rules: [migration-workflow.md](./migration-workflow.md)
- Per-PR checklist: [migration-checklist.md](./migration-checklist.md)
- Full schema (tables/columns/relationships): [v3-data-model.md](./v3-data-model.md)
- RLS model: [02_SECURITY_AND_RLS.md](./02_SECURITY_AND_RLS.md)
- Firestore→Supabase data migration (future): [v3-migration-plan.md](./v3-migration-plan.md)

## Migrations (all `implemented`, `verified-local`, `ci-enforced`, `not-hosted-applied`)
| File | Purpose | Landed |
|---|---|---|
| `0001_core_schema.sql` | Core tables (tenants, memberships, organizations, apps, contracts, app_contracts, people, identity_accounts, app_users, matches, license rules/evaluations, files, invoices, audit_logs); `tenant_id` + RLS enabled; `is_tenant_member` / `has_tenant_role`; baseline tenant policies. | starter (pre-PR) |
| `0002_org_scoped_rls.sql` | Org-scoped RLS: org helpers, steward-write policies, audit append-only trigger, `enforce_owning_org_tenant`, tenant-admin self-promotion fix. | PR #1 |
| `0003_org_access_union.sql` | Related-org **read** model (union of owning-org columns); broadened integrity trigger to all access org FKs. | PR #1 |
| `0004_destructive_delete_hardening.sql` | Remove normal authenticated **hard-delete** from core evidence tables (`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`): drop broad `FOR ALL` manage policies, recreate as `INSERT` + `UPDATE` only (no `DELETE`). RLS-only (no schema change). This is where the **contract write authority** lives (tenant editor+ / procurement-org steward); the future write *path*/*audit*/*UI* are designed in [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md) (not yet built). | PR #16 |
| `0005_same_tenant_child_integrity.sql` | **Same-tenant relational integrity:** `UNIQUE (id, tenant_id)` on 7 parents + composite same-tenant FKs on child/link tables (`app_contracts`/`app_users`/`app_user_identity_matches`/`identity_accounts`/`organizations`/`license_rules`/`license_evaluations`/`invoices`) so a child can't reference a cross-tenant parent. Constraints only (adds FK Relationships to generated types). | PR #17 |
| `0006_org_scoped_app_contracts_read.sql` | One permissive `SELECT` policy making `app_contracts` **org-scoped for read** — read a link iff you can read the linked **app OR contract** (reuses their RLS; tenant-bound by `0005`). SELECT-only, no `DELETE`. Proven by T28. | PR #20 |
| `0007_org_scoped_app_users_read.sql` | One `SELECT` policy making `app_users` **org-scoped for read** — read a row iff you can read the linked **app** (explicit tenant-bind, mirrors `0003`). SELECT-only, no `DELETE`. Proven by T29 (incl. T29h corrupt-row defense). | PR #21 |
| `0008_org_scoped_app_user_identity_matches_read.sql` | One `SELECT` policy making `app_user_identity_matches` **org-scoped for read** — read a match iff you can read the linked **`app_user`** (explicit tenant-bind). Exposes match *status*, no PII. SELECT-only, no `DELETE`. Proven by T30. | PR #23 |
| `0009_harden_app_contracts_read_tenant_bind.sql` | **Defense-in-depth:** replaces the `0006` org-scoped `SELECT` on `app_contracts` with one that pins `a.tenant_id`/`c.tenant_id = app_contracts.tenant_id` explicitly (matching `0007`/`0008`). **Valid-row behavior unchanged**; a planted FK-bypassed corrupt cross-tenant link is now denied. SELECT-only, no `DELETE`/`FOR ALL`; `0006` not edited. Proven by T28h. | PR #27 |
| `0010_contracts_audit_on_write.sql` | **Contract audit-on-write:** a `SECURITY DEFINER` `AFTER INSERT OR UPDATE` trigger `contracts_audit_on_write` (function `public.audit_contract_write`) appends one append-only `audit_logs` row per **accepted** contract write — `action`=`contract.created`/`contract.updated`, `resource_id`=`NEW.id`, `actor_user_id`=`auth.uid()` (the caller, not the owner/service-role), curated non-sensitive metadata in `after_json`. **No policy/authz change** (existing RLS still decides writes); **no** DELETE / `FOR ALL`; **no** `authenticated` INSERT on `audit_logs`; **no** service-role. `AFTER`, so denied/failed writes never audit. Invisible backend (no schema column / generated-type change). Proven by T31/T32. | PR #29 |

## Workflow (summary — full rules in [migration-workflow.md](./migration-workflow.md))
1. **Local first.** Never develop against hosted Supabase; never use service-role keys for normal dev.
2. **Append-only after merge.** Add the next sequential `000N_*.sql`; never edit a merged migration — fix forward.
3. **Test before every DB PR** (commands below); both run in CI on every PR.
4. **Hosted apply is a separate, reviewed deployment step** — *not* a side effect of merging. Staging before production, with post-apply verification. (No hosted apply has happened yet.)
5. Every RLS change ships ≥1 positive and ≥1 negative authorization test.

## Exact commands
```bash
bash scripts/check-migration-safety.sh   # numbering, no dup numbers, unsafe-keyword lint (+ `selftest`)
bash scripts/test-rls.sh                  # apply ALL migrations to throwaway Postgres + run RLS assertions
bash scripts/check-docs-updated.sh        # flag docs drift vs origin/main
bash scripts/pr-review-summary.sh         # categorize the diff + suggest reviewer focus
```
`scripts/test-rls.sh` and `check-migration-safety.sh` are also enforced by
`.github/workflows/rls-tests.yml` and `migration-safety.yml`. `check-docs-updated.sh`
runs in `review-discipline.yml`.

## Local/demo fixture (NOT a migration)
`supabase/fixtures/local_demo.sql` is sample data (a Demo Tenant, organizations, memberships,
sample apps/contracts) for local dev and demos — **not** schema, **not** a migration, and it
lives outside `supabase/migrations/` so it is never in the migration apply path.
- Run it: `bash scripts/seed-local-demo.sh` (seed + verify, then tear down) or `--keep` to leave a
  local DB up on `127.0.0.1:55432`. The script spins up its **own throwaway Postgres container**
  (like `test-rls.sh`) — it cannot reach hosted Supabase, refuses remote/`--linked` args, calls no
  Supabase CLI, uses no service-role key, and reads no secrets. The fixture is applied twice to prove idempotency.
- **Never hosted-apply** it: it inserts synthetic rows into `auth.users` (valid only against a local
  auth shim/stack; hosted GoTrue owns that table) and is all-synthetic demo data. See [04 · RISK-015](./04_RISK_REGISTER.md).
- It is rerunnable: deterministic UUIDs + idempotent upserts, no `TRUNCATE`.

## Dangerous patterns the safety check flags
`scripts/check-migration-safety.sh` fails on `DROP TABLE`, `TRUNCATE`, or
`DISABLE ROW LEVEL SECURITY` unless the file carries an explicit
`-- safety-ack: <reason>` note (forcing a human to state why it is safe).

## How to add a tenant-owned table (rule)
```sql
create table public.<t> (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ...,
  created_at timestamptz not null default now()
);
alter table public.<t> enable row level security;
create policy "<t> members read"   on public.<t> for select using (public.is_tenant_member(tenant_id));
create policy "<t> editors manage" on public.<t> for all
  using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
```
Then add positive + negative tests to `supabase/tests/org_rls_test.sql`.

## How to add an org-scoped access FK (rule)
1. Add the org FK column (e.g. `<x>_org_id uuid references public.organizations(id)`).
2. Add the column to `enforce_owning_org_tenant`'s per-table list **and** its trigger's
   `update of (...)` columns, so it is tenant-bound.
3. Use `has_org_role_in_tenant(<col>, tenant_id, ...)` (write) or a tenant-bound `EXISTS`
   union (read) — never bare `has_org_role` without the tenant binding.
4. Add tests: related-org read works, non-steward cannot write, foreign-tenant FK is blocked.

## Do **not**
- ❌ a tenant-owned table without `tenant_id` + RLS.
- ❌ an access-relevant org FK without tenant-binding (in trigger **and** policy).
- ❌ a `SELECT` policy without a tenant condition (directly or via helper).
- ❌ frontend filtering used as a security boundary.
- ❌ a service-role workaround to "get around" a too-strict RLS policy — fix the policy + test it.
- ❌ editing any merged migration (`0001`–`0010`) — fix forward with a new `000N_*.sql`.
