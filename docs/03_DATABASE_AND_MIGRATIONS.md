# 03 · Database & Migrations

**Canonical source for: migration list + database/migration workflow.** The detailed
process and PR template already exist and are CI-tied — this doc is the entry point and
links them rather than restating:
- Process rules: [migration-workflow.md](./migration-workflow.md)
- Per-PR checklist: [migration-checklist.md](./migration-checklist.md)
- Full schema (tables/columns/relationships): [v3-data-model.md](./v3-data-model.md)
- RLS model: [02_SECURITY_AND_RLS.md](./02_SECURITY_AND_RLS.md)
- Firestore→Supabase data migration (future): [v3-migration-plan.md](./v3-migration-plan.md)

### 0079 — the `oauth_completer` narrow identity

The least-privilege database role that completes a real Slack OAuth callback from the web tier (docs/83).

Completing a callback needs three capabilities: read the app client-secret **envelope**, consume the single-use
`oauth_pending` row, and store the returned bot-token **envelope**. The existing code reaches all three as
`connector_runner_login` — the runner's identity, which can execute every `runner_*` function in the schema. Putting
that in a public web tier means a request-path bug does not merely leak a token, it lets an attacker fabricate
directory evidence.

So 0079 creates `oauth_completer`: LOGIN, **no password in the migration** (set out of band), `NOSUPERUSER NOCREATEDB
NOCREATEROLE NOREPLICATION NOBYPASSRLS`, member of no role, **zero table and sequence privileges**, and EXECUTE on
exactly three purpose-specific wrappers. Each wrapper pins its provider and purpose, takes no plaintext parameter,
builds no dynamic SQL, and is `security definer set search_path = ''`.

It also closes an inherited hole: nine `SECURITY DEFINER` RLS predicate helpers were executable by **any** role via
Postgres's default PUBLIC grant. `authenticated`/`service_role` already held explicit grants and `anon` is re-granted,
so removing the PUBLIC path changes nothing for existing roles while closing it for new ones.

Two properties cannot be tested against a database here — `scripts/test-rls.sh` blanket-grants EXECUTE and then
re-revokes named sets (masking a broadened grant), and `connector_app_secrets` constrains provider and secret_kind to
single values (making those pins unobservable in data). Both are asserted statically by
`scripts/oauth-completer-migration.test.ts`.

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
| `0011_contract_form_parity_fields.sql` | **Contract form parity fields:** additive `alter table public.contracts add column` — `category text`, `procurement_date date`, `notes text`, `po_number text` (nullable) + `auto_renew boolean not null default false`, `month_to_month boolean not null default false` (the `0001` boolean convention). Closes the schema-backed legacy contract-form gaps (docs/15). **Non-destructive** (existing rows read NULL / false); **no** RLS/policy change, **no** DELETE/`FOR ALL`, **no** audit-trigger change, **no** service-role — the existing `0004` write authority + `0010` audit govern the new columns automatically. `database.types.ts` regenerated. `commodity_*` (hidden in legacy) + `validated` (read-only) deliberately not added. | PR #32 |
| `0012_files_metadata_foundation.sql` | **Files metadata foundation** (first DB step of [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)): additive `alter table public.files add column` — `contract_id uuid`, `storage_bucket`/`content_type`/`sha256` text, `byte_size bigint`, `extraction_result_json jsonb`, `extraction_error` text (nullable) + `upload_status`/`scan_status` (`not null default 'pending'`), `extraction_status` (`not null default 'not_started'`), `updated_at` (`not null default now()`). Composite **same-tenant FK** `(contract_id, tenant_id) → contracts(id, tenant_id)` (`0005` pattern, reuses `contracts_id_tenant_key`); **CHECK** constraints on the three status enums + `byte_size ≥ 0` + 64-hex `sha256`; tenant-scoped indexes for future reads/job sweeps. **Non-destructive** (nullable / NOT NULL-with-default); **no** RLS policy, **no** Storage/upload/AI/UI, **no** DELETE/`FOR ALL`, **no** service-role, **no** `updated_at` trigger (schema convention — default-only). `files` stays **default-deny / not surfaced** (RISK-002 OPEN). Proven by **T33** (RLS suite 177 → 186). `database.types.ts` regenerated (only the 11 new `files` columns). | PR #34 |
| `0013_files_rls_policies.sql` | **Files RLS policies** (§5 step of [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)): the first `files` policies — **SELECT** `is_tenant_member(tenant_id)` (tenant-member read; org-scoped read deferred) + **INSERT** `uploaded_by = auth.uid() AND can_write_contract(contract_id, tenant_id)` (the `0004` contract-write authority: tenant editor+ OR procurement-org manager; **`paying_org_id` grants no write**). New `SECURITY DEFINER` helper `can_write_contract` (stable, `search_path=public`; never references `paying_org_id`; no recursion). **NO UPDATE** (status transitions are a future worker — docs/16 §6/§8), **NO DELETE, NO `FOR ALL`**. Policies only — **no** table/column change, **no** Storage/upload/signed-URL/scan/AI/UI/service-role; `files` is authorized-by-design + tested but **still not surfaced**. Proven by **T34** (+ T27/T33 updated; RLS suite 186 → **205**). `database.types.ts` adds only the `can_write_contract` function. RISK-002 narrows for `files` read but stays OPEN. | PR #35 |
| `0014_contract_file_storage_auth_helpers.sql` | **Contract-file Storage auth helpers** (the predicates [22 §5](../docs/22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)'s staging `storage.objects` policies will call): `can_write_contract_file(file_id, tenant_id)` = a `files` row exists for the pair **AND** `can_write_contract(f.contract_id, f.tenant_id)` (never `paying_org`); `can_read_contract_file(file_id, tenant_id)` = a `files` row exists **AND** `is_tenant_member(f.tenant_id)`. Both `SECURITY DEFINER`, `stable`, `search_path=public` — definer bypasses `files`-SELECT RLS so an org-only manager (write-not-read, the `0013` asymmetry) still authorizes; no recursion. **Public-schema functions only — NO `storage.*` object, no bucket, no policy applied** (storage policies are staging-only, never a migration — docs/21). Proven by **T35** (RLS suite **205 → 222**). `database.types.ts` adds only the two functions. **Storage object policies remain NOT applied; RISK-001 stays OPEN.** | PR #51 |
| `0016_files_uploader_finalize_update.sql` | **Files uploader-finalize UPDATE policy + privilege correction** — a NARROW UPDATE so the **uploader** can finalize their OWN contract-file row's disposition after the Storage object upload (the gap PR #76 left; staging found `pending`/orphan rows — doc 41 §11/§12). Policy `"uploader finalizes own file"` (idempotent drop-if-exists): USING + WITH CHECK = `uploaded_by = auth.uid() AND can_write_contract(contract_id, tenant_id)` (uploader-only; `uploaded_by`/`tenant_id`/`contract_id` cannot be reassigned). **PRIVILEGE FIX:** a `grant update (col)` is **additive** and never removed the BROAD DELETE/TRUNCATE/UPDATE `authenticated` held on `public.files` (no migration granted these — hosted setup did; **staging verification caught it before merge** — doc 41 §13). So this migration `revoke update, delete, truncate on public.files from authenticated` then `grant update (upload_status)` — after it `authenticated` holds EXACTLY `SELECT, INSERT, UPDATE(upload_status)` (**no DELETE, no TRUNCATE**; `safety-ack` for the REVOKE-TRUNCATE keyword). **NO DELETE/`FOR ALL` POLICY, NO new Storage policy, NO service-role, NO bucket/column change; SELECT/INSERT (0015) + service_role untouched.** Proven by **T36** (row scoping) + **T37** (privilege surface: no DELETE/TRUNCATE; UPDATE only on `upload_status`, not any immutable column). The local `test-rls.sh` harness re-asserts the migration-intended `files` grants after its blanket crutch so T37 reflects the real hosted surface (the prior masking is the gap this closes; T33d/T34c/T34d reconciled). RLS suite **222 → 248**. `database.types.ts` 0-diff (policy/grant only). **RISK-001 stays OPEN.** | PR #78 |

> **Connector-vault migrations (`0017`–`0033`)** are documented in detail in [42_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) (RISK-007 gated sequence): `0017` (connector_secrets table + deny-all RLS), `0021`/`0022` (the `connector_runner` NOLOGIN/BYPASSRLS role + oauth_pending grants), `0029`/`0030` (connector_secrets COLUMN-scoped INSERT/SELECT grant + the complete encrypted-envelope columns), and **`0031` (PR #167) — a COLUMN-scoped INSERT for `connector_runner` on `public.audit_logs`, EXACTLY the four append-only columns `(tenant_id, action, resource_type, after_json)`, enabling ATOMIC, fail-closed connector-secret store audit (the secret INSERT and its audit INSERT share ONE runner transaction). audit_logs ONLY, INSERT ONLY; no select/update/delete; the 0002 append-only trigger still blocks mutation for the runner; no other table broadened.** and **`0032` (PR #169) — the Model B INSERT-only `connector_secret_lifecycle_events` table (revoked/tombstoned/superseded lifecycle state) + an append-only trigger + a COLUMN-scoped SELECT grant for `connector_runner` (EXACTLY tenant_id, connector_id, secret_kind, version, lifecycle_event_type) for the lifecycle-aware load — NO runner INSERT/UPDATE/DELETE (writes deferred to the next PR); `connector_secrets` unchanged.** and **`0033` (PR #170) — a COLUMN-scoped INSERT for `connector_runner` on `connector_secret_lifecycle_events` of EXACTLY the eight safe-metadata columns (tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id), enabling the runner-only `revoke`/`tombstone` write helpers (one atomic CTE: lifecycle INSERT WHERE EXISTS the target + an unconditional `attempted` audit + a `succeeded`/`failed`(`target_not_found`) terminal that derives from the lifecycle insert → exactly one terminal). Keeps the 0032 SELECT; NO UPDATE/DELETE; `connector_secrets` UNTOUCHED; a nonexistent target commits NO lifecycle row (the helper throws).** Proven by **T43/T44/T50/T51/T52/T53/T54** in the RLS suite. `database.types.ts` adds the lifecycle table at 0032 (0029–0031 and 0033 are grant-only 0-diff). RISK-007 remains OPEN.

> **Connector-runner discovery WRITE BOUNDARY (`0041`, Phase 2a, PR #255)** — the DB write boundary for the (future, gated) connector-runner live discovery sync: `connector_runner` writes `discovery_facts` + `connector_runs` **only** through three `SECURITY DEFINER` functions — **`runner_open_connector_run`** (connector must belong to tenant → append a `running` run), **`runner_finish_connector_run`** (run must belong to tenant → terminal `succeeded`/`failed` on the real 0019 columns `completed_at`/`records_seen`/`failure_code`), and **`runner_insert_discovery_fact`** (`source_run_id` must belong to tenant; **`fact_type` allowlist `{app_user_account, group}`**; `source_type` allowlist = the discovery `SourceTypeSchema`; `fact_json` must be an object whose `fact_type` matches; **recursive forbidden-key scan** `token/secret/ciphertext/dek_wrapped/aead_` over `fact_json`+`provenance_json`; `schema_version` pinned `'1'`; allowed columns only, no `reviewed_*`/`rejected_reason`; **idempotent** via a new partial unique index on `(tenant_id, source_provider, fact_type, signal_id)` + `ON CONFLICT DO NOTHING`). **`connector_runner` gets `EXECUTE`-only** on these functions (revoked from `PUBLIC`) and **NO broad/direct table INSERT/UPDATE/SELECT** — explicit `REVOKE ALL` on both tables. Chosen over an RLS policy because `connector_runner` is `BYPASSRLS` (a policy would be silently ignored); **NO `BYPASSRLS` change, NO `FORCE RLS`, NO new RLS policy, `connector_secrets` UNTOUCHED, no unrelated grant.** Each function is `SECURITY DEFINER` with a pinned empty `search_path` and **no dynamic SQL**. Decision recorded in connector-runner `docs/CONNECTOR_SYNC_PHASE_2_RUNBOOK.md` §5. Proven by **T62** (`connector_runner_writer_test.sql`, W1–W12). **Verified local; APPLIED + VERIFIED on hosted STAGING `ycdpzduxugdsffjqyoai` (2026-07-06, Gate 2a)** — dry-run confirmed only `0041` pending; post-apply verification passed (3 functions exist, `SECURITY DEFINER` true, `search_path` pinned, `EXECUTE` only to `connector_runner` / revoked from `PUBLIC`, no direct table privileges on `discovery_facts`/`connector_runs`, `connector_secrets` grants + `BYPASSRLS` role attributes UNCHANGED from baseline, idempotency index present, a synthetic rolled-back T-shape passed). **NOT applied to production. RISK-007 remains OPEN; Phase C remains BLOCKED.**

> **Connector credential-reference persistence (`0043`, Phase 5D, PR #318)** — a DEDICATED, provider-neutral, server-only **deny-all** table `public.connector_credential_references` holding only a credential-reference **POINTER** (an EXTERNAL secret reference — e.g. an AWS Secrets Manager ARN — + a version), **NEVER a credential value**. WHY a separate table (NOT columns on `connectors`): `connectors` carries a table-wide `authenticated` SELECT and a table-level grant covers EVERY column (RLS filters rows, not columns), so a reference column on `connectors` would let any tenant member read the ARN via PostgREST — so this MIRRORS the Tier-2 `connector_secrets` model: **RLS-enabled with ZERO policies (default deny-all)** + explicit `revoke all` from `anon`/`authenticated` (request-path roles get **NOTHING** — no read, no write). The row is bound to its owning connector by a **composite same-tenant FK** `(connector_id, tenant_id) → connectors(id, tenant_id) ON DELETE CASCADE` (`0005` pattern — a reference can exist only for a SAME-TENANT connector; `unique (tenant_id, connector_id, provider)`); reference columns are NOT NULL with length CHECKs. **`connector_runner` gets ONLY a NARROW COLUMN-scoped SELECT** on the five reference columns + identity/status on `connectors` for the eligibility JOIN — **NO write grant** (the runner cannot provision/rotate the reference); `connector_runner` is `BYPASSRLS`, so isolation is its tenant+connector+provider-bound WHERE, not a policy. **No backfill / no fabricated reference** — an absent row is INELIGIBLE and **fails closed** downstream; **missing metadata fails closed**. The schema hardcodes **NO account/region/namespace** (env-specific ARN validation stays in the runner). This migration **ACTIVATES nothing** (no status change, no write path, no client-facing policy); controlled provisioning (the write path), runtime activation, and Microsoft Entra enablement are deferred to separate GO-gated work. Server-only read via `src/lib/server/connector-vault/connector-credential-reference-store.ts` (`SET ROLE connector_runner`, parameterized, exact-one-row, redacted errors; enrolled in `no-client-import.test.ts`). Proven by **C0–C5** (`connector_credential_reference_test.sql`; see [rls_test_plan](../supabase/tests/rls_test_plan.md)). `database.types.ts` adds the reference table (connectors reverted — no credential column). **Verified local + CI; NOT applied to hosted Supabase. RISK-007 remains OPEN; Phase C remains BLOCKED.**

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

## Okta directory persistence (0052 · 0053 · 0054 · 0055 · 0056 · 0057 · 0058 · 0059 · 0060 · 0061)
Phase 4–11 of the Okta discovery engine. **Additive; activates nothing.**
- **0052** — provider-neutral connection lifecycle: widens the `connectors.connection_state` CHECK to the discovery vocabulary and adds `runner_advance_connection_state(connector,tenant,from,to)` (SECURITY DEFINER, pinned `search_path`, connector→tenant ownership, an explicit transition allowlist `verified→discovery_pending→discovering→discovered` + failure recovery — **no path to active/sync/scheduled**, NULL-endpoint guarded, optimistic current-state check). EXECUTE granted only to `connector_runner` (revoked from public/anon/authenticated).
- **0053** — durable persistence: the canonical Okta **directory identity** store is **`identity_accounts`** (extended), **not** `app_users` (a per-app account table). Immutable key = `(tenant_id, connection_id, provider, external_id)`; email/login are mutable optional attributes, never a uniqueness key; `raw_payload` is never populated by this path. Adds `connector_run_discovery` (per-run metrics), `connector_discovery_policy` (configurable stale thresholds), the `identity_account` fact type (positive key allowlist + strengthened forbidden-key scan), `runner_promote_okta_directory_users` (complete+clean-run gate, connection-qualified facts, idempotent upsert, first_seen preserved, superseded-run refusal), and `runner_mark_absent_okta_identities_stale` (evidence-based eligibility, first-run-stales-zero, configurable mass-staleness circuit breaker, latest-run guard, strict connection scope, never hard-deletes/unlinks people). All runner writes go through SECURITY DEFINER functions granted only to `connector_runner`. Tested in `supabase/tests/okta_directory_persistence_test.sql`.
- **0054** — durable **group** persistence (Phase 6): a NEW provider-neutral canonical table **`directory_groups`** (NOT `apps`/`app_users`/`identity_accounts`/any assignment table — a directory group is a distinct object class). Immutable key = `(tenant_id, connection_id, provider, external_id)` (`connection_id`+`external_id` NOT NULL); `name`/`description` are mutable attributes, never a key; there is **no `raw_payload` column at all**; **no memberships** (no member table, no `member_count`, `group_membership` deliberately absent from the fact allowlist). Adds the `directory_group` fact type (positive key allowlist), `runner_promote_okta_directory_groups` and `runner_mark_absent_okta_directory_groups_stale` — line-for-line analogues of the 0053 identity RPCs (complete+clean-run gate, superseded-run refusal, first-run-stales-zero, mass-staleness circuit breaker, strict connection scope, never hard-deletes). Reuses the 0053 `connector_run_discovery` metrics + `connector_discovery_policy` unchanged (a group run is a separate `connector_run`, distinguished by fact type). `group_type_category` is a bounded CHECK (`okta_group`/`app_group`/`built_in`/`other`) — the raw provider type is never stored. RLS deny-all; EXECUTE granted only to `connector_runner`. Tested in `supabase/tests/okta_directory_group_persistence_test.sql`.
- **0055** — bounded **read-only** group-membership support (Phase 7): two **SELECT-only** SECURITY DEFINER RPCs so the runner can drive a read-only membership *aggregate* (`GET /api/v1/groups/{id}/users`) that **persists nothing**. `runner_list_okta_directory_group_refs(tenant, connector)` returns the bounded set of **current** group `external_id`s for a tenant-owned okta connection (external_id ONLY — never name/description; `LIMIT 1000`). `runner_resolve_okta_identity_refs(tenant, connector, external_ids[])` returns **counts only** (`requested`/`matched`/`unmatched`) of member provider ids against `identity_accounts`, matching on `external_id` **equality only** (never email/login/name; cardinality-guarded ≤1000). Both gate on tenant+connection+`provider='okta'` ownership, pin `search_path`, add **no table grant** (the definer functions are the only read path; `connector_runner` keeps no direct SELECT), and revoke EXECUTE from public/anon/authenticated. **No membership table, no fact type, no write.** Tested in `supabase/tests/okta_group_membership_read_test.sql`.
- **0056** — durable **group-membership** persistence (Phase 8): a NEW provider-neutral canonical EDGE table **`directory_group_memberships`** (`directory_groups` ↔ `identity_accounts`; NOT `organization_memberships`/`tenant_memberships`/`app_users`/any assignment table — a directory-group membership is a distinct relationship class). Stores canonical **row-id references only** (`directory_group_id`, `identity_account_id`) + the 0053/0054 freshness/`sync_status` shape + provenance versions; there is **no `raw_payload` column**, no member email/login/name/`member_count`. Immutable relationship key = `(tenant_id, connection_id, provider, directory_group_id, identity_account_id)`. To DB-enforce that BOTH endpoints belong to the SAME tenant+connection+provider, adds a FULL (non-partial) unique constraint on each parent — `directory_groups_id_scope_key` / `identity_accounts_id_scope_key` `(id, tenant_id, connection_id, provider)` — targeted by two composite FKs (`dgm_group_fk` / `dgm_identity_fk`) plus the `dgm_connection_same_tenant` FK (both additive-safe: `id` is each table's PK, so the 4-tuple is already unique). Adds the `directory_group_membership` fact type (minimal positive key allowlist: only `fact_type`/`connection_id`/`group_external_id`/`user_external_id` — the deliberate reversal of 0054's "no memberships" as the DISTINCT provider-neutral type, NOT the app-scoped `group_membership`), `runner_promote_okta_directory_group_memberships` (complete+clean-run gate + superseded refusal + **dual-endpoint in-DB resolution that FAILS CLOSED**, counting-only, if any group OR user external_id does not resolve to a unique canonical row — no dangling edge can persist; idempotent upsert, first_seen preserved, `stale_since` cleared on reappearance) and `runner_mark_absent_okta_directory_group_memberships_stale` (the 0054 evidence-based ladder retargeted at edges: first-run-stales-zero, mass-staleness circuit breaker, latest-run guard, never hard-deletes). Reuses the 0053 `connector_run_discovery` metrics + `connector_discovery_policy` unchanged (a membership run is a separate `connector_run`, distinguished by fact type). Keeps `connection_state = discovered` (no advance — the membership run does not drive lifecycle). RLS deny-all; EXECUTE granted only to `connector_runner`; no direct table grant (definer functions are the only write path). Tested in `supabase/tests/okta_group_membership_persistence_test.sql`.
- **0057** — durable **application** persistence (Phase 10): a NEW provider-neutral canonical table **`directory_applications`** (a distinct object class from the operational **`apps`**, the customer-editable catalog **`app_products`**, and the matching table **`app_aliases`**) — the structural analogue of 0054 `directory_groups`. Immutable key = `(tenant_id, connection_id, provider, external_id)`; `label`/`name`/`status_category`/`sign_on_category` are mutable attributes (bounded CHECK buckets — never a raw provider value), never a key; there is **no `raw_payload` column** and **no assignments** (no app-user/app-group table, `app_user_account`-vs-application kept separate). Adds an **OPTIONAL nullable `catalog_product_id`** same-tenant FK → `app_products(id, tenant_id)` `on delete set null (catalog_product_id)` (the PG15 column-list form, so a catalog delete nulls only the link, never the NOT-NULL `tenant_id`) + `catalog_match_status` default `unmatched` — **catalog matching is deferred/optional: it stays NULL, and promotion NEVER writes `app_products`/`app_aliases` and NEVER fails on a missing match**. Adds the `directory_application` fact type (positive key allowlist), `runner_promote_okta_directory_applications` and `runner_mark_absent_okta_directory_applications_stale` — verbatim retargets of the 0054 group RPCs (complete+clean-run gate, superseded refusal, first-run-stales-zero, mass-staleness circuit breaker, strict connection scope, never hard-deletes). Reuses the 0053 `connector_run_discovery` metrics + `connector_discovery_policy` unchanged. RLS deny-all; EXECUTE granted only to `connector_runner`. Tested in `supabase/tests/okta_directory_application_persistence_test.sql`.
- **0058** — bounded **read-only** application-assignment support (Phase 11): two **SELECT-only** SECURITY DEFINER RPCs so the runner can drive a read-only application-**assignment** *aggregate* (`GET /api/v1/apps/{id}/users` + `/groups`) that **persists nothing**. `runner_list_okta_directory_application_refs(tenant, connector)` returns the bounded set of **current** `directory_application` `external_id`s (external_id ONLY — never label/name; `LIMIT 1000`) — the appIds to iterate. `runner_resolve_okta_directory_group_refs(tenant, connector, external_ids[])` returns **counts only** (`requested`/`matched`/`unmatched`) of app-group-assignment provider ids against `directory_groups`, `external_id` **equality only** (never name; any sync_status; cardinality ≤1000). The app-**user**-assignment resolver is the existing `runner_resolve_okta_identity_refs` (0055) **reused unchanged**. Both new RPCs gate on tenant+connection+`provider='okta'`, pin `search_path`, add **no table grant**, and revoke EXECUTE from public/anon/authenticated. **No assignment table, no fact type, no write.** Tested in `supabase/tests/okta_application_assignment_read_test.sql`.
- **0059** — durable **application-assignment** persistence tables (Phase 12, Migration A): the TWO NEW provider-neutral canonical EDGE tables — **`directory_application_user_assignments`** (`directory_applications` ↔ `identity_accounts`; DIRECT `scope=USER` grants) and **`directory_application_group_assignments`** (`directory_applications` ↔ `directory_groups`; group-to-app grants). Kept SEPARATE (different endpoint, canonical target, and future analytics — never one table with a nullable endpoint), and assignment-only: a group-to-app grant is stored as an edge, **never expanded to member users** (no effective access, no inheritance). Each is the 0056 membership-EDGE analogue with the endpoint swapped: canonical **row-id references only** (`directory_application_id` + `identity_account_id` / `directory_group_id`), the 0056 freshness/`sync_status`/provenance shape, **no `raw_payload` column**, no app label / group name / user login / email / assignment id / scope metadata, no `organization_id`. Immutable relationship keys `(tenant_id, connection_id, provider, directory_application_id, identity_account_id)` / `(…, directory_group_id)`. Adds the ONE missing FULL (non-partial) parent unique constraint `directory_applications_id_scope_key (id, tenant_id, connection_id, provider)` (0057 gave `directory_applications` only a PARTIAL index, unusable as an FK target; `identity_accounts`/`directory_groups` already got theirs at 0056) so both edges can composite-FK all three endpoints (`daua_application_fk`/`daua_identity_fk` + `daga_application_fk`/`daga_group_fk`, plus the same-tenant `*_connection_same_tenant` FK) — DB-enforcing that every endpoint belongs to the SAME tenant+connection+provider. RLS deny-all on both; no policy, no table grant, `connector_runner` revoked all direct DML (writes go only through the 0060 definer RPCs). No RPCs/fact types here. Keeps `connection_state = discovered`. Tested (with 0060) in `supabase/tests/okta_application_assignment_persistence_test.sql`.
- **0060** — durable **application-assignment** write boundary (Phase 12, Migration B): the fact types + promote/stale RPCs for the two 0059 edges. Adds the `application_user_assignment` + `application_group_assignment` fact types to `runner_insert_discovery_fact` (each a MINIMAL positive key allowlist — only `fact_type`/`connection_id`/`application_external_id`/`user_external_id`|`group_external_id`; source_endpoint + `*_version` ride in `provenance_json`; all prior fact types carried forward verbatim; the recursive forbidden-secret-key scan is fact-type-agnostic and needs no change). Adds `runner_promote_okta_application_user_assignments` + `runner_promote_okta_application_group_assignments` — the 0056 dual-endpoint promote retargeted (app+identity / app+group): complete+clean-run gate, superseded refusal, **dual-endpoint in-DB resolution that FAILS CLOSED** (counts only) if any endpoint external_id does not resolve to a unique canonical row (no dangling edge can persist), idempotent upsert with `first_seen` preserved + `stale_since` cleared, counts-only return. Adds `runner_mark_absent_okta_application_user_assignments_stale` + `..._group_assignments_stale` (the 0056 evidence-based ladder over each edge: first-run-stales-zero, mass-staleness circuit breaker, latest-run guard, `for update` serialization, never hard-deletes). A Phase-12 run emits BOTH fact types, so both promotes run against the same run's `connector_run_discovery` row; to avoid one clobbering the other, the assignment promotes deliberately do NOT write `facts_inserted`/`facts_updated` (authoritative per-type counts are the returned jsonb — nothing gates on that column for assignment runs). Reuses the 0053 `connector_run_discovery` metrics + `connector_discovery_policy` unchanged. Keeps `connection_state = discovered` (no advance). RLS deny-all; EXECUTE granted only to `connector_runner`; no direct table grant. Does NOT compute effective access, infer inheritance, or touch `apps`/`app_products`/`app_aliases`/`app_users`/`identity_accounts`/`directory_groups`/`directory_applications`/memberships. Tested in `supabase/tests/okta_application_assignment_persistence_test.sql`.
- **0061** — the FIRST customer read path onto the canonical directory graph (Phase 15 Part 1, PR A): **9 authenticated SECURITY DEFINER read RPCs**, chosen over broad user-scoped RLS SELECT because ordinary tenant membership is not sufficient evidence that every member may enumerate the whole access graph. The six canonical tables STAY DENY-ALL (this migration adds NO select policy and NO table grant to authenticated). Each RPC derives the caller from `auth.uid()`, VERIFIES tenant access via `has_tenant_role(p_tenant_id, {owner,admin})` (a passed tenant_id is verified, never trusted; a non-owner/admin — viewer/editor/non-member/anon — gets an empty/null result identical to a nonexistent tenant, no existence disclosure), pins `search_path`, uses NO dynamic SQL (filters are bound params), returns ONLY bounded safe fields (row-id UUIDs + safe display columns + `sync_status`/`stale_since`) and NEVER `external_id`/`raw_payload`/`normalized_*`/credentials/settings/profiles/`last_discovery_run_id`/`source_endpoint`, paginates deterministically (`order by id`, cursor `p_after_id`, page size capped 100), and makes a foreign-tenant or missing id return the same not-found. Inventory: `product_directory_access_counts` (counts); `product_list_directory_{identities,groups,applications}` + `product_list_{group_memberships,user_assignments,group_assignments}` (bounded paginated lists); `product_identity_access_subgraph` + `product_application_access_subgraph` (entity-focused bounded neighborhoods). EXECUTE granted to `authenticated` only; public + anon denied; connector_runner untouched. No write, no data migration. Tested in `supabase/tests/access_product_read_rpcs_test.sql` (owner/admin read; editor/viewer/non-member/anon denied; tenant isolation; foreign/missing = not-found; no external_id leak; pagination cap; stale policy). The `scripts/test-rls.sh` harness re-revoke list now includes the five new `directory_*` tables so the suite reflects their real deny-all posture.

## Do **not**
- ❌ a tenant-owned table without `tenant_id` + RLS.
- ❌ an access-relevant org FK without tenant-binding (in trigger **and** policy).
- ❌ a `SELECT` policy without a tenant condition (directly or via helper).
- ❌ frontend filtering used as a security boundary.
- ❌ a service-role workaround to "get around" a too-strict RLS policy — fix the policy + test it.
- ❌ editing any merged migration (`0001`–`0013`) — fix forward with a new `000N_*.sql`.

---

## 0064 — Okta connector validation result (O2C.2)

The authorized write path for a LIVE validation outcome. 0063 built the creation path and made it structurally incapable of
claiming verification, which left no way to record a validation that actually happened.

**Trusted producer.** `runner_record_okta_connector_validation(...)` is granted to `connector_runner` **only**. Validation success
is a fact about the outside world that only the runner observes, so no browser role can assert it — that is an absent grant, not a
policy decision.

**`revoke ... from public` is NOT sufficient on Supabase.** ALTER DEFAULT PRIVILEGES grants EXECUTE on new public functions to
`anon`, `authenticated` and `service_role` as EXPLICIT grantees, which a PUBLIC revoke leaves in place. Each role must be named.
The first run of the 0064 suite caught an OWNER successfully recording a result because of this. The same pattern exists on the
older `runner_*` functions — they are SECURITY DEFINER with internal tenant checks, so the exposure is bounded, but their
"runner-only" claim is weaker than written.

**Additive only, no new vocabulary.** `succeeded`/`failed` already existed in 0063; `verified` already existed in 0052.
`signing_key_id` is reused as the verified KID — 0063 reserved it for exactly that.

**Pinned KID.** The expected KID is a CHECK on the table, so not even a superuser UPDATE can record a different one. Key rotation
is therefore a deliberate migration.

**Evidence is all-or-nothing.** A `succeeded` row must carry fingerprints, KID, contract version, run id and timestamp together.

---

## 0065 — Okta per-capability evidence, contract pin 1.2.0 (O2C.3)

`okta_connector_capability_evidence` — one row per proven-or-failed read capability (`users_read`, `groups_read`, `apps_read`),
each bound to tenant, connector, a server-generated `connector_run`, the pinned KID and the contract version it was proven under.

**Why a table, not three booleans.** 0064 recorded ONE outcome, correct when there was one thing to prove. With three read scopes,
a single status would lose which scope was actually exercised — "the connector is verified" must never be able to mean "we tried
users and assumed the rest."

**Isolation.** A failed capability updates only its own row, so a groups failure cannot erase a users success. The demotion guard
refuses `verified -> failed` outright, so a proven capability never reaches the failure branch at all.

**Runner-only**, with `anon`/`authenticated`/`service_role` each revoked by name (a PUBLIC revoke does not remove Supabase's
default-privilege grants — see 0064).

**Contract pin moved 1.1.0 -> 1.2.0** in `runner_record_okta_connector_validation`, in lockstep with the artifact recording
`live_kid_verification: verified`. The pin and the artifact cannot move independently: a stale pin silently rejects every future
submission.

**Backfill.** The users_read row is transcribed from the O2C.2 validation that already earned it — same run id, KID and
timestamp, and `contract_version` left at **1.1.0** because that is what it was proven under. Making historical rows read 1.2.0
would be tidier and false.

---

## 0066 — Okta capability vocabulary: memberships and assignments (O2C.4)

Widens the bounded `capability` CHECK (and the identical IN-list inside `runner_record_okta_capability_evidence`) to add
`group_memberships_read`, `app_user_assignments_read` and `app_group_assignments_read`.

**Three, not two.** App-USER and app-GROUP assignments are separate Okta endpoints that can fail independently — an
administrator role can permit one and refuse the other — so a single "assignments" flag could claim access that does not exist.

**Nothing else changes.** Table, RLS, audit trigger, pinned KID, pinned contract version, idempotency, demotion guard and
direct-write denial all carry over and apply to the new capabilities unchanged.

**Both lists must move together.** The function's own vocabulary guard runs BEFORE the constraint, so widening only the CHECK
would still refuse the new values — as a function error rather than the omission it is.

**Existing evidence is preserved by construction:** widening an IN-list rejects nothing previously accepted and rewrites no row.
`users_read` keeps `contract_version = 1.1.0`.

---

## 0067 — Connector lifecycle re-arm (O2D.1)

Adds ONE transition: **`discovered -> verified`**.

**Why.** 0052's table had recovery paths out of `partial_failure` and `error`, and a rollback out of `discovery_pending` — every
way out of a discovery that did NOT succeed. It had none out of `discovered`. A connector that COMPLETED discovery was terminal,
so the second sweep failed at `verified -> discovery_pending` with "connection_state is not verified". Repeat discovery — and
therefore stale marking, and therefore any scheduled sync — was not representable. Found by the O2D.1 baseline run, which died
before opening a run or contacting Okta.

**Deliberately NOT `discovered -> discovery_pending`.** The invariant that every discovery begins from `verified` is preserved and
`discovery_pending` keeps a single entry path. The re-arm reuses the existing recovery idiom rather than adding a second one.

**The re-arm moves a flag and nothing else.** It creates no connector run, writes no discovery row, and cannot alter provider,
KID, contract version or governance flags — the function does not name those columns. Asserted, not assumed.

**Grants unchanged:** `connector_runner` only, with anon/authenticated/service_role revoked by name (a PUBLIC revoke does not
remove Supabase's default-privilege grants).

Stale gating is untouched and asserted so by the suite.

---

## 0068 — Okta stale-transition audit (O2D.2)

Adds an immutable audit event for every real `current -> stale` transition on the six canonical Okta resources: identity
accounts, directory groups, directory applications, group memberships, application user assignments, application group
assignments. (`app_users` also has `sync_status` but is not an Okta discovery target and is out of scope.)

**A trigger, not an insert inside the six RPCs.** The trigger's `WHEN (old.sync_status = 'current' and new.sync_status =
'stale')` makes "only real transitions are audited" structural rather than something six functions must each remember. It also
covers any future path that performs the transition. The `runner_mark_absent_okta_*_stale` functions are NOT modified —
reproducing ~490 lines across four migrations to insert six audit calls would put every threshold and completeness gate into the
diff, which is the opposite of leaving their behaviour unchanged.

**The four no-event cases fall out for free**, because none of them updates a row: breaker triggered and incomplete/ineligible run
both return before the UPDATE; an already-stale row is excluded by the RPC's `sync_status = 'current'` predicate; a replay with no
new absence matches zero rows.

**Bounded payload, exact key set:** connector, provider, resource type, prior/new status, stale timestamp, last-seen run, fixed
reason code. No provider payload, name, email/login, token, assertion, signature, digest, exception text or ARN — asserted by an
exact-key-set check, not a substring scan.

**`last_seen_run_id` is named precisely.** It is the run that last SAW the row present, not the run that staled it: the stale
UPDATE deliberately leaves `last_discovery_run_id` alone, which is what makes an absent row identifiable. The staling run is
recoverable by correlating `stale_since` against `connector_run_discovery`. Recording a guessed value would put inference into an
audit record.

**Forgery-proof:** `audit_logs` has RLS with a SELECT-only policy (no INSERT policy), browser roles cannot UPDATE the directory
tables, the writer is revoked from anon/authenticated/service_role, and `audit_logs_no_mutation` makes a written row immutable for
every role.

---

## 0069 — Close abandoned smoke connector runs (O2E cleanup)

The O2C.2/O2C.3/O2C.4 bounded smokes each call `runner_open_connector_run` to obtain a server-generated run id for their
capability evidence, then exit without finishing it — they are one-shot probes, not sweeps. Seven were left `running`.

Harmless (no `connector_run_discovery` row, so they can never satisfy the stale gate) but not acceptable: a permanently-`running`
run misrepresents system state and will confuse any future "is a sync in flight?" check.

Closed as `canceled` — an existing terminal status and the truthful one — with `failure_code = 'abandoned_smoke_validation'`.
The reason is a failure CODE, not a new status value: the run-status vocabulary is a lifecycle contract and widening it for a
housekeeping event would be permanent.

Scoped by three independent predicates, any one of which makes it a no-op elsewhere: the exact controlled connector id,
`status = 'running'`, and the ABSENCE of a `connector_run_discovery` row. The third distinguishes "opened a run id and exited"
from "was actually discovering", so a real stuck sweep is never touched. One bounded audit event per closed run.

## 0070 — `sync_status = 'current'` → `stale_since IS NULL` (Phase 2.1)

Four of the six Okta promote RPCs cleared `stale_since` when restoring a row to `current` — `runner_promote_okta_directory_group_memberships`
(0056), `..._directory_applications` (0057), and both assignment promoters (0060). Two did not:
`runner_promote_okta_directory_users` (0053) and `runner_promote_okta_directory_groups` (0054).

An identity or group that disappeared from Okta, was marked stale, then reappeared therefore ended up `sync_status = 'current'` carrying
the `stale_since` from when it went missing. Nothing failed; the row held a contradiction, and any reader trusting `stale_since` over
`sync_status` reported a live record as last seen months ago. The Directory list pages worked around it by only rendering the timestamp on
rows that were actually stale — a UI workaround for a database defect.

Three parts:

1. **Repair** on all six discovery tables, not only the two that can produce the state — a repair covering just the paths believed broken
   cannot prove the others were clean. Scoped to `sync_status = 'current'` so a genuinely stale row's evidence is never erased, and
   idempotent (`stale_since is not null` keeps the write off correct rows).
2. **Both promote functions replaced**, with `stale_since = null` added to the do-update-set. The bodies were extracted from 0053/0054 and
   edited on exactly one line each, verified by diff before assembly. The four already-correct promoters are NOT reissued.
3. **A validated CHECK** on all six tables: `sync_status <> 'current' or stale_since is null`. Added `NOT VALID` then `VALIDATE` as separate
   statements so the file stays safe against a large table later.

**A CHECK, not a normalizing trigger.** A `BEFORE UPDATE` trigger nulling `stale_since` whenever a row became `current` would also work and
would cover paths that do not exist yet. It was rejected: it would silently repair every future occurrence of the same bug, so the next
promote function written without the clear would look correct forever. The CHECK fails at the moment the mistake is written.

Only `current` is constrained — `stale`, `review_required` and `disconnected` may all legitimately carry a timestamp.

**Unchanged:** stale thresholds, the mass-staleness circuit breaker, completeness/eligibility gates, the latest-run supersession guard,
connector scoping, discovery ordering, promotion budgets, and the 0068 audit triggers. The repair moves no row between statuses, so it
fires no audit trigger (those carry `when (old.sync_status = 'current' and new.sync_status = 'stale')`) — asserted in the suite, not assumed.

## 0071 — One Okta organization, one active connector (P0)

A tenant could hold two connector rows reading the SAME Okta organization, and every product surface counted both. Staging tenant
`aaaa1111-…` had exactly that: `Okta (A1 Procurement)` (2026-07-21, 5 runs, no `okta_connector_configs` row — it predates 0063) and
`Okta Staging (O2C.2 verification)` (2026-07-30, 24 runs, validated config for `trial-5294016.okta.com`). Home reported 2 people
where the organization has 1, 9 groups where it has 7, and 4 applications where it has 2.

**The proof that it is one organization** is Okta external ids — opaque, globally unique, provider-issued. Measured before the fix:
every legacy `external_id` was also present under the controlled connector (1/1 identities, 2/2 groups, 2/2 applications) and none
was unique to the legacy one. The legacy row set is a strict subset: the same organization, read twice.

**The rule.** Supersession is DECLARED, not inferred. `connectors` gains `superseded_by` / `superseded_at` / `superseded_reason`
(all three set together, enforced by CHECK; no self-supersession). Product reads then exclude any row whose connector carries the
pointer. Nothing guesses at read time — a rule like "prefer the newest" would silently change what a customer sees whenever the
underlying facts shift.

Explicitly NOT how this is solved: no `DISTINCT`, no dedup on name/label/login/email, no "pick one row per external_id". Those
choose a winner per ROW; the duplication is per CONNECTOR, and only connector-level ownership resolves it without inventing a
preference between two equally real records.

All nine 0061 read RPCs are reissued with one added predicate. Each body un-patches to byte-identical 0061. Enforcing in the
database rather than the application is what makes Home, People, Groups, Directory applications, Access, Findings and both detail
pages agree by construction. The two subgraph functions gate their ANCHOR select, so a superseded record is indistinguishable from
one that never existed.

**Nothing is deleted or rewritten.** Every legacy row keeps its data, its `sync_status` and its connector. `connector_runs`,
`connector_run_discovery`, `discovery_facts` and `audit_logs` are untouched. The exclusion is read-time only — clearing the pointer
restores the rows immediately.

**Distinct organizations stay supported.** The filter keys on the per-connector pointer, so two Okta connectors for two genuinely
different organizations are both unsuperseded and both fully visible.

The staging supersession is recorded in section 4, guarded so it is a no-op unless both connectors exist in the same tenant, the
survivor has a validated config, the superseded one has none, and every legacy `external_id` has a counterpart under the survivor.

## 0072 — `product_group_access_subgraph` (Phase 3)

Groups were the one directory object with no home. People and applications each had an entity subgraph since 0061; a group could
only be listed, and its row action pointed at filtered findings because there was nothing else to point at. Group membership is
one of the two ways a person reaches an application, so "who is in this group and what does it grant" is a first-order question
the product could not answer.

Two deliberate differences from the 0061 subgraphs:

1. **Connector-scoped edges.** The identity and application subgraphs scope by tenant + anchor id. This one also scopes every edge
   and every neighbour row by the ANCHOR GROUP'S `connection_id`. Composite endpoint FKs already make a cross-connector edge
   impossible, so this is defence in depth — but it is the property that keeps two connectors reading the same Okta organization
   from bleeding into each other, which is the P0 that 0071 closed. Tested by dropping the FKs, planting the forbidden rows, and
   requiring the RPC to exclude them on its own authority.

2. **Bounded inside the function.** A group is the fan-in case: "Everyone" is one row pointing at every identity in the tenant. The
   other two subgraphs let the loader cap the result after the RPC has built it, which for a group means materializing the whole
   membership list as jsonb first. This one counts first and returns `bounded: true` with the summary and NO arrays — it fails
   closed rather than truncating, because a half-populated member list that looks complete is worse than an honest refusal.

The anchor is supersession-gated, so a group owned by a superseded connector returns null: the same answer as a group that does not
exist and as one belonging to another tenant. Three causes, one indistinguishable response.

`userAssignments` is scoped to (this group's members × the applications this group grants) so the existing Phase-13 engine can tell
whether a member ALSO holds an application directly — the difference between "this group is how they get in" and "one of two ways".
Derived by the engine from those rows, never computed in SQL.

Read-only, definer, pinned `search_path`, EXECUTE to `authenticated` only. No raw payload column exists on any of these tables, and
`external_id` / `normalized_*` / plumbing columns are not projected.

## 0073 — Connector management: disconnect, scoping, inventory (Phase 5)

The product assumed one directory. A workspace can have several — Corporate Okta, a sandbox, a subsidiary — and they are separate
organizations whose graphs are never merged.

**Disconnect.** 0071 gave us supersession: "this connector was replaced by that one". That is right for *replacing* a connector and
wrong for switching a directory off, because there is no successor to point at. Rather than a second exclusion mechanism, both now
feed ONE notion of active: `superseded_by` (replaced) or `disconnected_at` (retired, no successor); neither set means active.
Disconnect is a read-time exclusion — no row, run or audit event is removed, and reconnect restores everything by clearing a
column. An auditor asking "who could reach this application in June" must still get an answer after the connector is gone.

**The active predicate**, widened across all ten product read RPCs. Every body un-widens to byte-identical 0071/0072.

**Connector scoping.** The 0061 RPCs always accepted `p_connection_id`; nothing ever sent it, so every surface read the whole
tenant. The DAL now passes it, and the scope travels in the URL (`?connection=<uuid>`), so Home, Directory, Access and Findings
cannot disagree. `null` still means "every active connector" — correct for a single-directory tenant.

**Two management reads.** `product_connector_inventory` returns one row per connector with lifecycle, evidence timestamps and
directory counts, so the management page is one round trip regardless of how many directories exist. It is the ONE product read
that deliberately returns inactive connectors — hiding them would make disconnect look like deletion. `product_connector_runs`
returns a connector's discovery history. Counts are per connector and never summed: adding two organizations' headcounts produces
a number that is true of nothing.

**Three operator actions**, each owner/admin-only, tenant-scoped, reason-bearing and self-auditing:
`product_disconnect_connector`, `product_reconnect_connector`, `product_replace_connector`. Deliberately NOT expressed as
`connection_state` transitions — that column is the DISCOVERY lifecycle governed by 0067, and pushing retirement through it would
make a connector's history read as though a sweep had happened. Retirement is orthogonal, so a reconnected connector resumes
exactly where it left off.

## 0074 — Stale-aware counts: `current` vs `totalEvidence` (Phase 6)

`product_directory_access_counts` counted every row regardless of `sync_status`. That was deliberate — it is the conservative
pre-gate for the too-large check, and a bound must never under-count. But the same number is what the `too_large` FALLBACK
displays, so a directory with 6 current groups and 1 retained stale group told the customer "7 groups" while every list showed 6.

Both readings are legitimate and answer different questions, so both are now named:

| key | meaning | used for |
|---|---|---|
| `current` | what the directory contains now | every customer-facing number |
| `stale` | retained, last seen in an earlier discovery | include-stale views |
| `other` | any other row state the CHECK permits | reported, never folded |
| `totalEvidence` | every retained row | the safety gate, exclusively |

**Four states, not two.** `sync_status` is CHECK-constrained to `('current','stale','review_required','disconnected')`. Only the
first two are written today — nothing in either repository writes the others — but folding them into `stale` would be a silent
miscategorisation that surfaces only when something starts writing them. So `other` is a named term and the invariant is
`totalEvidence = current + stale + other`.

**The bound did not weaken.** `totalEvidence` reproduces exactly the numbers the gate used before; a stale row still occupies a row
in any response that includes stale evidence, so gating on `current` would under-count the worst case. Tests assert both that the
bound is never below `current` and that it is strictly larger whenever stale rows exist.

**Backward compatibility.** The six flat keys are retained with their existing meaning — total evidence — and documented as
deprecated aliases of `totalEvidence`. No caller changed meaning silently; the two production callers moved to the explicit
structure in the same change. Same signature, so no argument contract shifted.

Scope is unchanged: tenant, optional connector, optional provider, and the exclusion of superseded and disconnected connectors.
All-active mode sums distinct connector graphs and deduplicates nothing — two organizations may legitimately contain the same
person, and collapsing them by name, email or provider external id would erase a real record.

