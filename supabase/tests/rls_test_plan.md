# RLS Test Plan

Before building UI, prove these pass against local Supabase.

## Test users
- owner_a: owner in Tenant A
- editor_a: editor in Tenant A
- viewer_a: viewer in Tenant A
- org_manager_a1: manager in Tenant A / Org A1
- owner_b: owner in Tenant B

## Required cases
1. owner_a can read Tenant A apps.
2. owner_a cannot read Tenant B apps.
3. viewer_a can read but cannot update Tenant A apps.
4. editor_a can create/update Tenant A apps.
5. editor_a cannot manage tenant memberships unless policy allows it explicitly.
6. org_manager_a1 can update records assigned to Org A1 only, once scoped org policies are added.
7. org_manager_a1 cannot update records assigned to Org A2.
8. no normal user can update/delete audit_logs.
9. service-role job can write license_evaluations.
10. browser anon/authenticated client cannot read integration secrets.

## Org-scoped policies — IMPLEMENTED in migrations 0002 + 0003 (+ 0004 delete-hardening)

Cases 1–8 plus the org/cross-tenant/escalation matrix are enforced by
`supabase/migrations/0002_org_scoped_rls.sql` and `0003_org_access_union.sql`,
covered by the runnable suite `supabase/tests/org_rls_test.sql` (T1–T49, 492 assertions; T38/T39 cover the
connector-vault schema foundation (`0017`) — T38 = `connectors`/`connector_runs` tenant-member read + no
request-path write; T39 = `connector_secrets` deny-all (RLS-enabled, zero policies, `authenticated`/`anon`
hold zero privilege) + the no-secret-column-leak structural check; **T40 = the hardened grant surface
(`0018`)** after staging found broad anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on
the Tier-1 tables — exact per-role privilege arrays (authenticated=`[SELECT]` on connectors/connector_runs,
zero on connector_secrets; anon=zero everywhere) + TRUNCATE/REFERENCES/TRIGGER negatives + tenant-scoped
SELECT still works + cross-tenant SELECT still RLS-denied; **T41 = the `connector_runs` run-lifecycle schema
(`0019`)** — the six lifecycle states accepted (queued/running/succeeded/failed/canceled/timed_out) + an
out-of-set status rejected + the renamed/added safe columns (completed_at, records_seen/imported/failed,
failure_code, failure_label) present with the old names gone + no secret column + grant shape unchanged
(authenticated `[SELECT]` only, anon zero, no write policy, audit still reuses append-only `audit_logs`);
**T42 = the `oauth_pending` single-use replay store (`0020`)** — near-Tier-2 deny-all: RLS-enabled + ZERO
policies + `authenticated`/`anon` hold EXACTLY zero privilege (no read/insert/update/delete, no
TRUNCATE) + structural posture (`expires_at` NOT NULL, UNIQUE `state_jti`/`nonce_hash` single-use, a
cross-tenant connector binding blocked by the composite FK, no raw nonce/state/code/token/secret column) +
`connector_secrets` and the Tier-1 grant surface unchanged by `0020`;
**T43 = the `connector_runner` DB grant foundation (`0021`)** — a dedicated NOLOGIN BYPASSRLS server-only
runner role granted ONLY `oauth_pending` SELECT + a column-level UPDATE on EXACTLY
{consumed_at, attempt_count, last_rejected_code} (no DELETE/TRUNCATE/REFERENCES/TRIGGER, no UPDATE on
the immutable identity columns; the INSERT grant lands later in `0022`/T44), ZERO privilege on
connector_secrets/connectors/connector_runs (deferred) + a functional proof (the runner can SELECT + set
`consumed_at` (the §38 consume shape) but cannot delete/update-identity-columns/read connector_secrets) +
anon/authenticated deny-all unchanged (zero on oauth_pending/connector_secrets, `[SELECT]`-only on
connectors/connector_runs, oauth_pending still zero policies; a normal authenticated user still cannot consume
oauth_pending or touch connector_secrets);
**T44 = the `connector_runner` authorize-time INSERT grant (`0022`)** — adds a COLUMN-LEVEL INSERT on
`oauth_pending` for EXACTLY the 9 §50 authorize-time columns
{tenant_id, organization_id, connector_id, provider, subject, state_jti, nonce_hash, intent, expires_at}
(the runner can INSERT a replay row but NOT supply consumed_at/attempt_count/last_rejected_code on INSERT) +
a functional proof (the runner inserts an authorize-time row supplying the allowed columns, but a
non-granted column like `consumed_at` on INSERT is permission-denied) + the existing surface unchanged (SELECT
kept; UPDATE columns still EXACTLY the 3 consume columns; still no DELETE/TRUNCATE/REFERENCES/TRIGGER; still
ZERO on connector_secrets/connectors/connector_runs) + anon/authenticated deny-all + zero-policy posture
unchanged after `0022`;
**T50/T51 = the `connector_runner` connector_secrets storage grant (`0029`/`0030`)** — the runner has a COLUMN-scoped SELECT/INSERT on `connector_secrets` (the identity + complete encrypted-envelope columns), NO table-level privilege, and NO UPDATE/DELETE (rotation/revocation deferred); T51 runs the store adapter's EXACT active/non-expired SELECT shape as the runner.
**T52 = the `connector_runner` audit_logs INSERT grant + ATOMIC store-audit (`0031`, PR #167)** — the runner has a COLUMN-scoped INSERT on `audit_logs` of EXACTLY `(tenant_id, action, resource_type, after_json)` and nothing else (NO select/update/delete/truncate, NO `actor_user_id`/`before_json`/`resource_id`/`ip_address`/`user_agent`, NO grant on any other table), plus FUNCTIONAL proofs under `set role connector_runner`: (a) a single transaction with the connector_secrets INSERT + the audit_logs INSERT commits BOTH rows; (b) when the audit INSERT fails (naming a non-granted column), the whole transaction ROLLS BACK and NO connector_secrets row remains (no compensating delete); (c) the runner cannot UPDATE or DELETE an audit row (append-only enforced for the runner);
**T45 = the graph-scale discovery indexes (`0023`)** — asserts a representative sample of the 36 schema-grounded
indexes exists (the RLS-hot-path `tenant_memberships_user_tenant_status_idx`, the high-volume
`app_users_*`/`identity_accounts_*` discovery indexes, the `*_person_idx` app_user→person match indexes, the
`lower(email)`/`lower(name)`/`lower(primary_email)` FUNCTIONAL case-insensitive indexes, the
`lower(vendor_name)` normalization indexes, the owning-org `*_org_idx` joins, and the invoices/app_contracts/
license indexes) + the schema-grounding guards (NO `identity_account_id` column on `app_user_identity_matches`;
the match graph is app_user → person and identity_account → person via `person_id`). Index-only — no
grant/policy/RLS-behavior change;
**T46 = the canonical vendor/product/app-instance graph (`0024`)** — the three new tenant-scoped tables
(`vendors`/`app_products`/`app_aliases`) are RLS-enabled with EXACTLY {SELECT, INSERT, UPDATE} policies (the
`0004`-hardened members-read + editors-insert/update posture, NO DELETE/ALL) + FUNCTIONAL tenant isolation (a
Tenant A member reads its vendor/product/alias, a Tenant B member reads zero, a non-editor cross-tenant INSERT
is RLS-`with check`-denied, and a cross-tenant `app_products.vendor_id` link is rejected by the same-tenant
composite FK — the `0005` pattern, mirroring T26/T38) + the new `apps` columns exist (`canonical_app_id`,
`instance_domain`, `external_instance_id`, `instance_url`) + `app_contracts` is UNCHANGED (its `(app_id,
contract_id)` PK intact, no canonical/instance columns) + NO `identity_account_id` column is introduced + the
`app_aliases` audit/review fields (confidence/review_status/reviewed_by/reviewed_at) exist + `connector_secrets`
still has zero policies (untouched by `0024`);
**T47 = the discovery_facts ingestion staging boundary (`0025`)** — the tenant-scoped validated-fact staging
table is RLS-enabled with EXACTLY {SELECT, INSERT, UPDATE} policies (the `0004`-hardened members-read +
editors-insert/update posture, **NO DELETE** — staged facts are DURABLE review records) + FUNCTIONAL tenant
isolation (a Tenant A member reads its fact; a Tenant B member reads ZERO — tenant A cannot read tenant B; a
Tenant A editor's cross-tenant INSERT is RLS-`with check`-denied; a Tenant B member's UPDATE of a Tenant A fact
scopes to ZERO rows and the row stays `pending`) + the staging columns + `review_status` default `pending` +
`fact_json` NOT NULL + `connector_secrets` STILL zero policies and **NO `connector_runner` grant on
`discovery_facts`** (the helper inserts only through the user-scoped authenticated RLS context, never
service-role);
**T48 = the deterministic resolver write — persisted-state idempotency (`0026`)** — the FIRST canonical-graph
mutation path upserts `app_aliases` / `apps.canonical_app_id` on NATURAL KEYS, proven at the persisted-state
(real-Postgres) layer: the alias natural-key `UNIQUE(tenant_id, alias_type, alias_value)` exists (`0026`);
re-running the EXACT same deterministic write (vendor/product/alias upserts + canonical_app_id set) a second
time does NOT increase the app_alias / app_products / vendors row counts (`ON CONFLICT DO NOTHING`); two
distinct `instance_domain` values (Flywheel + Perpetua) stay TWO aliases under ONE product and TWO separate
apps rows (no collapse); unmerge is NON-destructive (clearing `canonical_app_id` leaves the apps row + its
`app_users`/`contracts`/`invoices` intact); repoint is an UPDATE (no alias-count change, no deletes); and a
Tenant B member cannot read Tenant A's resolver-written aliases (RLS). A CONFLICTING alias key (already resolving to a different product) is NOT overwritten — ON CONFLICT DO NOTHING keeps the original target (the false-merge guard, proven on real Postgres). Fixtures are T48-namespaced to stay
isolated from T46;
**T49 = the deterministic app_user → person identity-match write (`0027`)** — `0027` adds the write surface to
`app_user_identity_matches` (editors INSERT + editors UPDATE, **NO DELETE** — the `0004` directive), so the
deterministic identity-match helper can write through the authenticated RLS path. Proven at the persisted-state
(real-Postgres) layer: the policy set is EXACTLY {SELECT, INSERT, UPDATE} (no DELETE/ALL); re-inserting the SAME
`(tenant_id, app_user_id)` match does NOT increase the row count (the `0028` `UNIQUE(tenant_id, app_user_id)`,
`ON CONFLICT DO NOTHING`, 1:1 deterministic) — and a SECOND match for the same `(tenant, app_user)` to a
DIFFERENT person is REJECTED (`unique_violation`, the false-double-match guard the editor INSERT policy must
not be able to violate), the original preserved; repoint is an UPDATE that changes `person_id` to the correct person WITHOUT changing the
row count and WITHOUT deleting the app_user / person / app / match (non-destructive correction); and a Tenant B
member can neither READ a Tenant A match nor INSERT one (RLS `with check`). Fixtures are T49-namespaced. The
helper additionally (in TS) writes ONLY on deterministic evidence (exact normalized email / exact provider
external id), fails closed on no-evidence / multiple-people / tenant-mismatch / existing-different-person, and
writes no app graph / app_alias / vendor / product row;
the later tests cover the `files` foundation/policies — T33 `0012`, T34 `0013` SELECT/INSERT (+ T34c DELETE
denied at the privilege layer), T35 `0014` storage-auth helpers, **T36 `0016` the uploader-finalize
UPDATE policy** (uploader may set `upload_status` on their OWN row; cross-tenant / cross-user updates and
`uploaded_by`/`tenant_id` reassignment denied), and **T37 the `files` privilege surface** for
`authenticated`: SELECT + INSERT, **no DELETE, no TRUNCATE**, UPDATE only on `upload_status` (never any
immutable column). The harness re-asserts the migration-intended `files` grants after its blanket crutch
so T37 reflects the real hosted privilege surface — staging caught a broad DELETE/TRUNCATE/UPDATE grant
that the blanket crutch had masked). The suite has been executed against Postgres 16 with a Supabase-style
`auth` shim — all assertions pass (`ALL ORG-RLS ASSERTIONS PASSED`).

**Destructive-delete hardening (T17/T24/T25, migration `0004`):** core evidence tables
(`organizations`/`apps`/`contracts`/`app_contracts`/`people`/`app_users`) have **no `DELETE`
policy** — `FOR ALL` manage policies were split into `INSERT`+`UPDATE`. T17 = org-manager delete
denied; T24 = owner/admin/editor delete denied (editor `UPDATE` still works, rows survive);
T25 = `/apps` + `/apps/[id]` reads still valid.

**Same-tenant child integrity (T26, migration `0005`):** composite `(parent_ref, tenant_id) →
parent(id, tenant_id)` FKs on `app_contracts`/`app_users`/`app_user_identity_matches`/`identity_accounts`/`license_rules`/
`license_evaluations`/`invoices`. T26 = 11 cross-tenant link inserts each rejected with
`foreign_key_violation`; valid same-tenant links + nullable (MATCH SIMPLE) links still insert.
This is write-integrity only — org-scoped child-table reads remain deferred (RISK-002).

**Child-table read-scope truth pass (T27, PR #18 — docs/tests only, no migration):** asserts the
*current* read reality without broadening it. The 6 **default-deny** tables (`identity_accounts`,
`app_user_identity_matches`, `license_rules`, `license_evaluations`, `files`, `invoices`) return 0
rows even to a tenant **owner** (despite seeded rows). The **tenant-only** table `people` is readable
by tenant members but returns 0 rows to an **org-only** user. Positive controls (owner reads tenant
rows; org-only user reads its own-org app) prove the zeros are policy, not empty tables.
(`app_contracts` and `app_users` were tenant-only when T27 was written in PR #18; they have since become
org-scoped read in `0006`/`0007` and T27 was updated accordingly — see T28/T29.) Canonical read map:
[docs/02 §8](../../docs/02_SECURITY_AND_RLS.md).

**Org-scoped read for `app_contracts` (T28, migration `0006`; hardened by `0009`, PR #20/#27):**
`app_contracts` gains ONE org-scoped `SELECT` policy — an org-only user may read a link row iff they can
already read the linked **app OR contract** under related-org RLS (the `EXISTS` subqueries reuse
`apps`/`contracts` RLS; `0005` + the explicit tenant-bind added in **`0009`** keep it tenant-bound).
T28 proves: tenant owner reads all tenant links; org-only users read only links tied to apps/contracts
they can read (app-side **and** contract-side branches); cross-tenant (`owner_b`) and a pure non-member
(`nobody`) read 0; and the default-deny/tenant-only tables still read 0 for an org-only user (no
broadening leaked). **T28h** (`0009`) plants a normally-impossible FK-bypassed corrupt cross-tenant link
(tenant B, but `(app_id, contract_id)` point at a tenant-A app + contract the org user CAN read) and
proves the explicit tenant-bind hides it — a weak-vs-hardened check confirmed the old `0006` policy
would leak it. Valid-row behavior is unchanged. Read-only — no `DELETE` policy added.

**Org-scoped read for `app_users` (T29, migration `0007`, PR #21):** `app_users` gains ONE org-scoped
`SELECT` policy — an org-only user may read an app-user row iff they can already read the linked **app**
(the `EXISTS (select 1 from apps ...)` reuses `apps` RLS; `0005` keeps it tenant-bound). T29 proves:
tenant owner reads all tenant app_users; `mgr_a1` reads only App A1's users; `mgr_a2` reads App A-pay
(responsible) + App A2; `agency_u` reads only App A-pay (paying); `owner_b` reads only its own tenant-B
user (0 tenant-A); `nobody` reads 0; an org-only delete is denied (no `DELETE` policy — row survives);
and `people`/`identity_accounts`/`app_user_identity_matches`/`license_*`/`invoices`/`files` still read 0
for an org-only user. The `0007` policy pins `a.tenant_id = app_users.tenant_id` explicitly (defense in
depth, mirroring `0003`); **T29h** plants a normally-impossible FK-bypassed corrupt cross-tenant row
(`session_replication_role=replica`) and proves an org-only user who can read the parent app still
cannot read it. Read-only — no identity matching / license eval / provisioning.

**Org-scoped read for `app_user_identity_matches` (T30, migration `0008`, PR #23).** Implements
[docs/12](../../docs/12_IDENTITY_MATCHING_READ_SCOPE.md) §5: read a match row iff you can read the linked
**`app_user`** (itself org-scoped by `0007`), with an explicit tenant-bind. T30 proves: tenant owner
reads all tenant matches (transitively); org-only users read only matches of app_users they can read
(`mgr_a1`=App A1, `mgr_a2`=App A-pay+App A2, `agency_u`=App A-pay); `owner_b` (other tenant) + a pure
non-member read 0; a match read grants **no** `people`/`identity_accounts` read (org-only still 0);
org-only delete denied (no `DELETE` policy — row survives); `app_users` (T29) + `app_contracts` (T28)
org-read still hold; and **T30h** plants an FK-bypassed corrupt cross-tenant match and proves the
explicit tenant-bind hides it. Exposes match **status** only — no person/identity PII. The
`app_user_identity_matches` default-deny assertions in T27 27a / T29 29f were dropped (now org-scoped).

**Contract write tests (future — design only, [docs/13](../../docs/13_CONTRACT_STEWARD_WRITE_DESIGN.md) §7).**
The contract write **RLS authority already exists** (`0004` — tenant editor+ / procurement-org `manager`,
no `DELETE`/`FOR ALL`), and much is already proven: **T21** (paying-org member cannot write — read ≠
write), **T14** (cross-tenant write denied), **T22/T23** (trigger rejects foreign-tenant `procurement`/
`paying` org), **T17/T24** (hard-delete denied). A future write-UI PR must add only the *missing* proofs
(explicit positive steward `INSERT`, audit-event-on-write, a `pg_policies` 0-`DELETE`/`ALL` guard) plus
the server-action-uses-anon-client check (`check-auth-safety.sh`) — **before** any write UI ships.

### Access model: stewardship (write) vs. related-org (read)
- **WRITE / steward (single-org):** apps `responsible_org_id`, contracts `procurement_org_id` (or tenant editor+).
- **READ (multi-org, 0003):** app = responsible OR paying OR procurement-owner org; contract = procurement OR paying org. Keeps chargeback visible under centralized procurement.
- Tenant binding on every access org FK via the `enforce_owning_org_tenant` trigger.

Union-read cases (T18–T23): read app via `paying_org_id`; read app via
`procurement_owner_org_id`; read contract via `paying_org_id`; **centralized-procurement**
contract still readable by the paying agency; paying/procurement relation does **not**
grant write; foreign-tenant `paying_org_id` and `procurement_owner_org_id` blocked by the trigger.

Coverage added beyond the original cases:
- Cross-tenant **write** denial for tenant-wide roles (not just read).
- `org_manager` exact-org edit; cross-org / cross-tenant **edit + delete + insert** denial.
- No reassigning a resource into an unmanaged or **foreign-tenant** org (USING/WITH CHECK + integrity trigger).
- The **cross-tenant owning-org leak** found in adversarial review (a tenant member could point `apps.responsible_org_id` / `contracts.procurement_org_id` at a foreign-tenant org) — blocked by `has_org_role_in_tenant` + the `enforce_owning_org_tenant` trigger.
- `org_viewer` read-but-not-edit; org-only user baseline isolation (`tenants`/`organizations`).
- `organization_memberships` read isolation + no self-grant (own org or other org).
- A pre-existing **0001 escalation** (tenant admin self-promoting to `owner` / demoting the owner) — closed by splitting into owner-only vs admin-non-owner membership policies.
- audit_logs append-only verified against `authenticated` (no write policy) **and** `service_role` (BYPASSRLS, blocked by trigger incl. writable-CTE / upsert / MERGE).

Not org-scoped for reads (RISK-002, narrowed by PR #20/#21/#23; reality pinned by T27/T28/T29/T30, canonical map [docs/02 §8](../../docs/02_SECURITY_AND_RLS.md)):
**tenant-only** (tenant members read, org-only users do not) — `people`;
**default-deny** (no read policy at all) — `identity_accounts`,
`license_rules`, `license_evaluations`, `files`, `invoices`.
`app_contracts` (`0006`), `app_users` (`0007`), and `app_user_identity_matches` (`0008`) are now **org-scoped for read** — no longer in this list.

### Run locally

```bash
bash scripts/test-rls.sh
```

That script (the same one CI runs — `.github/workflows/rls-tests.yml`) spins up a
throwaway `postgres:16` container, installs a Supabase-style `auth` shim
(`auth.uid()` + the `authenticated`/`service_role` roles hosted Supabase provides),
applies every `supabase/migrations/*.sql` in order, applies the test-role grants,
then runs every `supabase/tests/*_test.sql` with `ON_ERROR_STOP=1`. Any failed
assertion fails the run (non-zero exit); the container is removed even on failure.
Requires Docker. It never touches hosted Supabase and uses no service-role keys.

New test files are picked up automatically as long as they are named `*_test.sql`.
