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
covered by the runnable suite `supabase/tests/org_rls_test.sql` (T1–T54, 611 assertions; T38/T39 cover the
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
**T53 = the `connector_secret_lifecycle_events` runner SELECT grant + APPEND-ONLY trigger (`0032`, PR #169)** — proves TWO SEPARATE protections: (1) the runner GRANT SHAPE under `set role connector_runner` — column-scoped SELECT on EXACTLY (tenant_id, connector_id, secret_kind, version, lifecycle_event_type); no table-level SELECT/INSERT; UPDATE/DELETE FAIL; the runner column grants are EXACTLY {SELECT, INSERT} — never UPDATE/DELETE (the INSERT is added by `0033`/#170, proven in T54); (2) the append-only TRIGGER itself, proven against a PRIVILEGED test/admin role that CAN attempt UPDATE/DELETE and is STILL rejected by the trigger (the `append-only` error — so the block is the trigger, not grant-absence); plus a functional proof that the lifecycle-aware load EXCLUDES an ACTIVE version carrying a `revoked` event, and that `connector_secrets` keeps no runner UPDATE/DELETE;

**T54 = the `connector_secret_lifecycle_events` runner INSERT grant + revoke/tombstone write atomicity + orphan prevention (`0033`, PR #170)** — under `set role connector_runner`: (1) GRANT SHAPE — the runner now has a COLUMN-scoped INSERT of EXACTLY the eight safe-metadata columns (tenant_id, connector_id, secret_kind, version, lifecycle_event_type, reason_class, actor_type, correlation_id), keeps the 0032 SELECT (5 cols), has NO table-level INSERT and NO UPDATE/DELETE/TRUNCATE, cannot INSERT id/created_at/audit_log_id, and `connector_secrets` still has no runner UPDATE/DELETE; (2) APPEND-ONLY STILL HOLDS now that the runner has INSERT — the runner's UPDATE/DELETE still FAIL and the 0032 trigger STILL rejects a PRIVILEGED role's UPDATE/DELETE (the `append-only` error; row unchanged / still exists after); (3) the ACTUAL helper CTE run as the runner — an EXISTING version commits the lifecycle row + `attempted` + `succeeded` (no `failed`, exactly one terminal); a NONEXISTENT version commits `attempted` + `failed`(`target_not_found`) with NO lifecycle row and NO `succeeded` (exactly one terminal — the failed attempt IS auditable, the orphan invariant binds only lifecycle rows); (4) ATOMICITY — a forced in-CTE `succeeded`-audit failure (a non-granted column) rolls back the lifecycle insert (no orphan, no compensating delete);
**T62 = the `connector_runner` discovery WRITE BOUNDARY (`0041`, PR #255, `connector_runner_writer_test.sql`)** — proves the three `SECURITY DEFINER` writer functions under `set role connector_runner`: **W1** grant shape (`EXECUTE` on exactly the three `runner_*` functions, revoked from `PUBLIC`; NO direct INSERT/UPDATE/SELECT/DELETE on `discovery_facts`/`connector_runs`); **W2** each function is `SECURITY DEFINER` with a pinned `search_path`; **W3** happy path (open run → insert fact → finish run; the fact defaults to `review_status='pending'` and `schema_version='1'`; the run ends `succeeded` with `records_seen`); **W4** cross-tenant connector open rejected; **W5** a `source_run_id` from another tenant rejected; **W6** invalid `fact_type` rejected; **W7** non-object `fact_json` rejected; **W8** `fact_json.fact_type` mismatch rejected; **W9** forbidden secret-like key rejected (recursive, keys-only); **W10** duplicate `signal_id` idempotent (one row); **W11** the runner cannot UPDATE/DELETE `discovery_facts` directly; **W12** `connector_secrets` grants unchanged. Local-only; the `0041` migration is NOT hosted-applied. RISK-007 remains OPEN; Phase C remains BLOCKED.

**T63 = the `connector_credential_references` deny-all table + `connector_runner` column-read (`0043`, Phase 5D, PR #318, `connector_credential_reference_test.sql`)** — proves the credential-reference store (a DEDICATED deny-all table holding an external secret **POINTER** — e.g. an AWS Secrets Manager ARN — never a credential value), cases **C0–C5**: **C0** the table is a Tier-2 deny-all store — NOT-NULL reference columns, RLS enabled, **ZERO policies** (default deny-all); **C1** under `set role connector_runner` the runner resolves the OWNED reference via the tenant-bound JOIN to `connectors` (`n_owned=1`), with the **BYPASSRLS CONTROL** — unscoped the runner CAN see another tenant's row (`n_bypass=1`, so RLS is NOT the boundary) but the tenant+connector+provider-bound WHERE returns NOTHING cross-tenant (`n_cross=0`) and a connector with no reference row **fails closed** (`n_noref=0`); **C2** the runner grant is NARROW — COLUMN SELECT on the five reference columns + `connectors` identity/status for the JOIN, **NO table-level SELECT** and **NO INSERT/UPDATE/DELETE** on either table (no provision/substitute/rotate); **C3** the REQUEST PATH is fully denied — `authenticated` and `anon` hold EXACTLY ZERO privileges and get `insufficient_privilege` at runtime for both read and insert (a tenant member cannot read the ARN via Supabase/PostgREST); **C4** the length CHECKs reject an empty `credential_version` and an over-length (513) `credential_secret_ref`; **C5** `connectors` is UNCHANGED — NO credential columns, `authenticated` still holds EXACTLY `[SELECT]`, and a new connector gets NO fabricated reference (fail closed by default; no backfill). Fixtures are SYNTHETIC (no real ARN/credential/account). Local-only; the `0043` migration is NOT hosted-applied. RISK-007 remains OPEN; Phase C remains BLOCKED.

**T64 = the non-secret Okta issuer-binding table + org-scoped RLS (`0048`, P5E18b, `connector_okta_issuer_binding_test.sql`)** — proves the per-organization Okta issuer binding holds ONLY non-secret metadata (org, provider, normalized host, canonical https issuer, environment, lifecycle, exact approved scope, audit/correlation — NO client secret / token / authorization code / PKCE verifier / credential payload), cases **I0–I4**: **I0** RLS enabled; the provider/scope/https/env CHECK constraints + the two partial unique indexes (active-per-org, active-per-issuer) exist; **NO secret-shaped column** exists; **I1** an organization **manager** reads ONLY its own org's binding (`has_org_role` scoped), a **viewer** reads nothing, and a manager of another org reads nothing (**cross-org denied**); **I2** the request path cannot WRITE — an `authenticated` manager cannot INSERT (`insufficient_privilege`) and UPDATE/DELETE affect **0 rows** (no write grant/policy; mutations are `service_role`-only); **I3** the CHECKs reject a non-Okta provider, a broader scope, an `http` issuer, and a non-staging environment; **I4** the active-issuer partial unique index blocks binding the same issuer to a **second** organization (no cross-org reassignment). Fixtures are SYNTHETIC (no real issuer/PII). Local-verified; the `0048` staging apply is a separate confirmed step. Okta remains certificationOnly; RISK-007 OPEN; Phase C BLOCKED.

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

## okta_directory_persistence_test.sql (Phase 4 — migrations 0052/0053)
Verifies the Okta directory-identity persistence boundary: runner RPC grants
(EXECUTE only to `connector_runner`; public/anon denied) and no direct table
access; lifecycle transition allowlist + ownership + optimistic + NULL guard;
promotion complete+clean-run gate; idempotent replay + immutable `external_id`
(email change keeps one row); cross-tenant + cross-connection isolation; nullable
email; first-run-stales-zero; complete-run stales-absent; partial/rejected/cap runs
stale-zero; mass-staleness circuit breaker; superseded-run refusal; identity_account
key allowlist; `raw_payload` never populated; no hard delete.

## okta_directory_group_persistence_test.sql (Phase 6 — migration 0054)
Verifies the Okta directory-**group** persistence boundary (`directory_groups`): runner RPC
grants (EXECUTE only to `connector_runner`; public/anon denied), no direct table access,
RLS deny-all, pinned `search_path`, and **no `raw_payload` column**; complete+clean-run
promotion gate (incomplete/rejected/cap/wrong-tenant blocked); idempotent replay + immutable
`external_id` with a **rename** updating the mutable `name` in one row; first_seen preserved /
last_seen advances; cross-tenant + cross-connection isolation; first-run-stales-zero;
complete-run stales-absent (scoped, non-destructive); partial run stales-zero; mass-staleness
circuit breaker; superseded-run refusal; `directory_group` key allowlist; **no memberships**
(`member_count` key + `group_membership` fact_type both rejected); bounded `group_type_category`
CHECK rejects an out-of-set category at promotion.

## okta_group_membership_read_test.sql (Phase 7 — migration 0055)
Verifies the two SELECT-only read RPCs for the bounded read-only membership aggregate:
grants (EXECUTE only to `connector_runner`; public/anon denied), pinned `search_path`, and
**no direct SELECT** on directory_groups/identity_accounts (the definer RPCs are the only read
path); `list_group_refs` returns **current** external_ids only (stale excluded), scoped per
connection, empty array when none, and rejects wrong-tenant/non-okta connections;
`resolve_identity_refs` returns **counts only** (requested/matched/unmatched), matches on
**external_id equality only** (an email value never matches), isolates cross-tenant + cross-
connection, treats a stale identity as matched (known), rejects null input, and enforces the
≤1000 cardinality guard.

## okta_group_membership_persistence_test.sql (Phase 8 — migration 0056)
Verifies the Okta directory-group **membership** EDGE boundary (`directory_group_memberships`):
runner RPC grants (EXECUTE only to `connector_runner`; public/anon denied), **no direct table
access** (not even SELECT), RLS deny-all, pinned `search_path`, and **no `raw_payload` column**;
complete-run promotion resolves both endpoints and creates one scoped edge binding the canonical
group + identity rows; the **dual-endpoint fail-closed** guard aborts the WHOLE promotion (no
partial edge) when a group OR user external_id is unresolved, including a mixed run; the
promotion gate blocks incomplete/rejected/wrong-tenant; idempotent replay updates without
duplicating (a group **rename** + identity **email change** still resolve to the same edge),
first_seen preserved / last_seen advances; cross-tenant + cross-connection isolation of the same
`(group,user)` pair into separate edges via the composite FKs; first-run-stales-zero;
complete-run stales-absent (scoped, non-destructive — stale not deleted); partial run
stales-zero; mass-staleness circuit breaker; and the `directory_group_membership` key allowlist
(a member email/name key rejected).

## okta_directory_application_persistence_test.sql (Phase 10 — migration 0057)
Verifies the Okta directory-**application** boundary (`directory_applications`): runner RPC grants
(EXECUTE only to `connector_runner`; public/anon denied), no direct table access, RLS deny-all,
pinned `search_path`, and **no `raw_payload` column**; complete-run promotion stores `label` +
bounded `status_category`/`sign_on_category`, leaving the **catalog link NULL/unmatched** (no
matcher run); promotion gate blocks incomplete/rejected/wrong-tenant + superseded; idempotent
replay updates without duplicating (a **label rename** updates in place), first_seen preserved /
last_seen advances; cross-tenant + cross-connection + cross-provider isolation of the same
`external_id`; the **optional catalog link** — a valid same-tenant FK is settable, a cross-tenant
product is rejected, deleting the catalog product `SET NULL`s only the link (the provider app
survives + `tenant_id` intact), promotion leaves `catalog_match_status` untouched and **never
writes `app_products`**; first-run-stales-zero; complete-run stales-absent (non-destructive);
partial run stales-zero; mass-staleness circuit breaker; the `directory_application` key allowlist
(a `settings`/url key rejected); and the bounded category CHECK (an out-of-set `status_category`
rejected).

## okta_application_assignment_read_test.sql (Phase 11 — migration 0058)
Verifies the two SELECT-only read RPCs for the bounded read-only application-assignment aggregate:
grants (EXECUTE only to `connector_runner`; public/anon denied), pinned `search_path`, and **no
direct SELECT** on directory_applications/directory_groups (the definer RPCs are the only read
path); `list_application_refs` returns **current** app external_ids only (stale excluded), scoped
per connection, empty array when none, and rejects wrong-tenant/non-okta connections;
`resolve_directory_group_refs` returns **counts only** (requested/matched/unmatched), matches on
**external_id equality only** (a group name never matches), isolates cross-tenant + cross-
connection, treats a stale group as matched (known), rejects null input, and enforces the ≤1000
cardinality guard. (The app-user resolver `runner_resolve_okta_identity_refs` is the 0055 one
reused.)

## okta_application_assignment_persistence_test.sql (Phase 12 — migrations 0059 + 0060)
Verifies the two application-assignment EDGE boundaries (`directory_application_user_assignments`
+ `directory_application_group_assignments`): the 0059 prerequisite `directory_applications_id_scope_key`
constraint exists; runner RPC grants (EXECUTE only to `connector_runner`; public/anon denied) on all
four promote/stale RPCs; pinned `search_path`; **no `raw_payload` column**; RLS deny-all (no policy)
+ **no direct edge DML** for `connector_runner` on both tables. Promotion: a complete+clean run
resolves BOTH endpoint kinds and creates one user edge + one group edge, connection-scoped to the
resolved canonical app+identity / app+group rows. **Dual-endpoint fail-closed**: an unresolved app,
user, or group aborts the WHOLE promotion (all-or-nothing — no partial/dangling edge). Promotion
gate blocks incomplete / rejected>0 / wrong-tenant runs. Idempotent replay updates (no duplicate
edge) with `first_seen` preserved + `last_seen` advanced even after an app label / group name
rename (external_id is the immutable key). Cross-tenant + cross-connection isolation (same
(app,user) external ids resolve to separate canonical endpoints → separate edges). Stale: first run
stales-zero; a complete second run stales an absent edge (never hard-deleted); partial run stales-
zero; mass-staleness circuit breaker. Fact-key allowlist rejects a non-approved key on BOTH
assignment fact types (a scope/login/group-name leak). **Separation invariant**: a group-to-app
assignment creates ONLY a group edge and does NOT fan out to user edges (no effective access).

## access_product_read_rpcs_test.sql (Phase 15 Part 1 PR A — migration 0061)
Verifies the authenticated SECURITY DEFINER product read RPCs onto the canonical directory graph. AR0: every canonical
table keeps RLS enabled + ZERO policies (migration-controlled deny-all) and the five new directory_* tables have no
authenticated SELECT grant; the RPCs are EXECUTE-only to authenticated, anon denied. AR1: owner + admin members read
counts/list/subgraph. AR2: editor + viewer denied (role gate = owner/admin only) with a not-found-equivalent empty/null.
AR3: cross-tenant — a member of tenant B passing tenant A's id (verify-not-trust) gets nothing; a tenant-A owner never
lists a tenant-B row; a foreign id and a missing id both return the same not-found. AR4: non-member denied. AR5: no
external_id/raw_payload/tenant_id leaks in any RPC output (incl. a recursive jsonb_path check of the subgraph). AR6:
current-only by default; include_stale surfaces the stale identity; pagination capped at 100.


## okta_connector_validation_result_test.sql (0064)

V0 grant shape: `connector_runner` holds EXECUTE; `authenticated`, `anon` and `service_role` do NOT. V1 owner, editor and anon
each CALL the function and must receive a privilege error — the negative property is proven by execution, not by reading a grant
table. V2 a well-formed result is recorded and the connector becomes `verified` and nothing more (`status` stays `pending`,
governance flags preserved). V3 audit exactly once with the precise action and no credential material. V4 idempotent replay emits
no second audit and does not move `last_validated_at`. V5 a stale failure cannot demote an established success. V6 superseded KID,
superseded contract version, malformed fingerprint, out-of-vocabulary outcome, forged run id and cross-tenant result are each
refused. V7 the pinned-KID CHECK holds against a direct owner UPDATE. V8 a succeeded row cannot survive losing its evidence.
V9 a request role still cannot UPDATE or DELETE the table directly.

The runner's own execution is asserted by grant shape rather than by SET ROLE: `postgres` holds its `connector_runner` membership
with `set_option = false`, so the harness cannot assume that role and claiming otherwise would be untrue.


## okta_capability_evidence_test.sql (0065)

K0 grant shape (runner only; anon/authenticated/service_role denied) plus an assertion that 0064's contract pin moved to 1.2.0.
K1 an owner can neither call the function nor INSERT directly. K2 capabilities are recorded independently and an unsubmitted
capability simply does not exist — a groups run cannot imply apps. K3 audit exactly once per result, no credential material.
K4 idempotent replay: no write, no second audit, no timestamp drift. K5 the isolation property — an apps failure leaves users and
groups verified and does not fail the connector validation. K6 a stale failure cannot demote a verified capability, and the FULL
evidence package survives the rejection. K7 stale KID, stale contract version, unknown capability, forged run and cross-tenant
result are each refused. K8 the pinned-KID CHECK and the verified-evidence CHECK hold against direct owner UPDATEs. K9 a viewer
reads only their own tenant and cannot write.


### 0066 additions (K7b)

The three membership/assignment capabilities each record as their own row. Recording app-USER assignments does NOT create or
imply app-GROUP assignments. Prior `users_read`/`groups_read` evidence is asserted intact afterwards, and an undeclared
capability (`app_admin_write`) is still refused. K9's viewer count rises from 3 to 5 rows accordingly.


## connector_lifecycle_rearm_test.sql (0067)

R0 grant shape. R1 owner/editor/viewer/anon can neither call the transition function nor write `connection_state` directly.
R2 the one new edge works. R3 a full SECOND discovery cycle completes, which is the point. R4 the shortcuts stay closed —
`discovered` may not jump to `discovery_pending`, `discovering` or `connected_unsynced`. R5 cross-tenant is refused; R5b a
transition claiming the wrong `p_from` is refused (optimistic concurrency). R6 the re-arm creates no run and no discovery row and
leaves provider/status untouched. R7 the stale gate still checks completeness, connection scope, last_page and the connector lock.

The R4/R5 negatives assert on a flag set OUTSIDE the exception handler. `raise exception` is P0001, so raising inside the block
and catching with `when others` swallows the failure — those negatives silently passed against a mutated function until a
mutation run exposed it.


## okta_stale_transition_audit_test.sql (0068)

T0 six triggers exist and no browser role may execute the writer. T1 inserting current rows and a status-preserving UPDATE emit
nothing. T2 one transition emits exactly one event, with an EXACT key set and no provider/credential data. T3 three transitions
emit three events, not one per batch. T4 a replay and a forced re-write of an already-stale row emit nothing. T5 a same-tenant
"legacy" connector row and another tenant's row are neither staled nor audited. T6 identities and applications are covered, not
just groups. T7 written events survive UPDATE and DELETE attempts. T8 owner/admin/editor/viewer/anon cannot forge an event.
T9 no forged event exists and the genuine ones remain.

All counts are scoped to this suite's fixture tenants: the harness runs every suite against one database and other suites
legitimately stale rows, so a global count would measure them too.

## current_stale_since_invariant_test.sql (0070)

C0 the CHECK exists on all six discovery tables and every one is VALIDATED (a `NOT VALID` constraint would let pre-existing bad rows
survive). C1 `current` + `stale_since` is rejected on INSERT and on UPDATE, across three different tables. C2 `stale`, `review_required`
and `disconnected` may still carry a timestamp — the invariant constrains only `current`. C3 the identity round trip through the REAL
RPCs: discovered → absent → stale with a timestamp → rediscovered → current with the timestamp cleared, `first_seen_at` preserved.
C4 the same round trip for groups (the 0054 path). C5 replaying a promote over an already-current row is idempotent and preserves
`first_seen_at`. C6 a promote clears `stale_since` for its OWN connector only — a sibling connector in the same tenant and a row in
another tenant both stay stale. C7 incomplete / rejected-records / not-last_page runs still cannot promote, and the gated row keeps its
`stale_since` — no ineligible path leaks through the new clear. C8 the 0068 audit still fires on `current → stale` and only there:
promote writes nothing, the newly fixed `stale → current` writes nothing, and a repair-shaped UPDATE writes nothing. C9 the repair is a
no-op on a repaired database and never clears a genuinely stale row. C10 no row anywhere violates the invariant after the whole suite —
the same query used for the hosted staging check.

Fixtures are sized to four entities with one disappearing (25%) so they clear the 30% mass-staleness circuit breaker WITHOUT altering it;
a two-row fixture trips the breaker and the test ends up asserting on the breaker rather than on the timestamp. The CHECK-constraint cases
use a dedicated connector so their hand-inserted rows stay out of the breaker's denominator in the RPC round-trip cases.

The repair's WHERE clause cannot be covered here — the harness applies migrations to an empty database, so it runs against zero rows.
That scope is asserted statically in `src/lib/data/stale-since-invariant.test.ts`.

## connector_supersession_test.sql (0071)

S0 the pointer's shape is enforced: a bare `superseded_by`, a reason with no pointer, and self-supersession are all rejected, and
no rejected attempt leaves a partial write. S1 reproduces the DEFECT — before supersession every surface double-counts. S2 after
recording it, the counts RPC and all six list RPCs return the same numbers, no list leaks a row owned by the superseded connector,
and `include_stale` does not resurrect one. S3 detail pages agree: the same person exists under both connectors as two rows, the
surviving one opens and the superseded one is indistinguishable from a record that never existed; the surviving subgraph does not
reference the superseded connector. S4 a genuinely DIFFERENT Okta organization in the same tenant stays fully visible, lists and
detail pages included — a "one okta connector per tenant" rule would have deleted it from the product. S5 nothing was deleted or
rewritten: every legacy row still exists, still `current`, still owned by the legacy connector, and the connector row remains with
its recorded reason. S6 the exclusion keys on OWNERSHIP, not row resemblance — giving the superseded row a different external_id,
login and display name does not bring it back, and clearing the pointer restores it immediately. S7 another tenant is unaffected
and authorization still governs.

Fixture `created_at` values are deliberately DISTINCT: with a tie, an "oldest row per external_id" implementation would fail at the
first count assertion for the wrong reason. Distinct timestamps let such an implementation appear to work, so it is caught by S1 —
which is the point, because a row-attribute dedup hides duplicates before any decision is recorded.

Two pre-existing suites were rescoped as part of this change: `AA6` (application assignments) and `MM6` (group memberships) each
asserted a GLOBAL `count(distinct connection_id)`. The harness runs every suite against one database, so those counts measured
other suites' fixtures and broke as soon as this one added connections. Both now scope to their own connector ids.

## group_access_subgraph_test.sql (0072)

G0 grant shape: EXECUTE to `authenticated` only, definer, pinned search_path, and no direct table SELECT for browser roles.
G1 the happy path — summary, current-only members, grants, and the member's direct holding of a granted application. G2
`include_stale` widens to the SAME connector only and is not a back door to a superseded one. G3 superseded, cross-tenant and
missing group ids all return null, addressed both with the caller's tenant and the owning tenant. G4 a genuinely different active
Okta organization in the same tenant stays fully readable. G5a the six composite endpoint FKs exist and a cross-connector edge is
rejected outright; G5b the FKs are then DROPPED, the forbidden rows planted, and the RPC must still exclude them on its own
authority — a redundant guard that is never exercised is one nobody notices removing. G6 no `external_id`, raw payload, tenant id,
run id, endpoint or `normalized_*` field appears anywhere in the response. G7 empty and stale groups resolve with real answers
rather than failures. G8 repeated calls are byte-identical (every array is ORDER BY'd). G9 an editor of the same tenant gets the
not-found answer — owner/admin only. G10 the fan-in bound: 2600 members puts the response over the 5000-row cap, and the RPC
returns the summary with `bounded: true` and NO partial arrays, while a small group in the same tenant is still evaluated.

G10 builds and removes ~5200 rows; it cleans up after itself so later suites in the shared database are unaffected.

## connector_management_test.sql (0073)

M0 grant shape for all five new functions, and the disconnect CHECK rejects a timestamp with no reason. M1 two active Okta
organizations stay separate: unscoped sees all three directories, scoped sees exactly one, the list agrees with the count on the
same scope, and scoping to one never leaks another's rows. M2 disconnect EXCLUDES but never deletes — counts and lists drop it,
explicitly scoping to it by id returns nothing, its group detail closes, and yet every identity/group/application/connector row
survives with the reason recorded and exactly one audit event written. M3 reconnect restores without rediscovery and is idempotent.
M4 replace uses supersession, refuses self-replacement and a cross-tenant successor, is audited, and a superseded connector can be
neither reconnected nor disconnected. M5 a blank reason is rejected for both disconnect and replace, and a retired successor is
refused — pointing at one would exclude both and leave the organization with no active directory. M6 an editor of the same tenant
can neither read the inventory nor disconnect, and an owner cannot act on another tenant. M7 the inventory is the one read that
SHOWS retired directories, retirement outranks the discovery state in the lifecycle column, a retired directory still reports its
contents, counts are per connector, and history survives.

## stale_aware_counts_test.sql (0074)

K1 one current and one stale of every resource yields current=1, stale=1, other=0, total=2 on all six, the invariant
`total = current + stale + other` holds as an equality, and the deprecated flat key still means total evidence. K2 the bound did
not weaken: `totalEvidence` is never below `current`, and is strictly larger whenever stale rows exist. K3 connector scope,
disconnected and superseded exclusion, all-active aggregation, and cross-tenant non-disclosure all survive the new shape — an
excluded connector returns zero rather than its data, and another tenant returns null rather than zeros. K4 all-active SUMS and
never deduplicates: two connectors holding the same external id, login and email both count. K5 a re-promoted row moves
stale → current without changing total evidence. K6 a `review_required` row is reported as `other`, never inflating `stale` or
`current`, and the invariant still holds with a third state present. K7 an editor still gets no counts at all.

## oauth_completer_narrow_identity_test.sql (0079)

C0 the granted surface is exactly three wrappers, and no OTHER security-definer function is reachable · C1 zero table
and sequence privileges, named table-by-table for the vault and evidence tables · C2 role attributes and membership in
no role · C3 no plaintext parameter exists · C4 the app-secret read is envelope-only, newest-active-version, and
tenant/connector/provider bound · C5 direct table access denied even holding the role, including opening a run or
writing a discovery fact · C6 consume is single-use with full trusted context; redirect mismatch, wrong tenant,
connector, subject, expiry and replay each refused with a bounded code · C7 store is envelope-only, versioned,
superseding and retry-safe · C8 exactly one active credential, the supersession audited, and **no** evidence created ·
C9 no refusal carries a secret, ciphertext, host, email or environment value.

## oauth_completion_jobs_test.sql (0081)

J0 the granted surface: five completion wrappers for `oauth_completer` only, one customer read for `authenticated` only,
nine `oauth_completer_*` wrappers in total, and no OTHER security-definer function reachable — including the new product
read · J1 the job table is Tier-2 deny-all (RLS on, zero policies, zero grants for anon/authenticated/connector_runner
**and** `oauth_completer`), and the role still holds zero table and sequence privileges after a new table exists ·
J2 no column or parameter can name a plaintext authorization code, and the payload is opaque `bytea` · J3 every binding
refused before a row exists — cross-tenant, wrong connector, non-Slack provider, foreign redirect, fabricated
correlation, a correlation issued for the tenant's OTHER Slack connector, an already-consumed authorization, an expired
authorization, malformed workspace, unsupported scheme, undersized and missing payload, out-of-grammar correlation —
each asserted on its exact bounded reason (a table CHECK would otherwise refuse anyway, from the wrong layer), and not
one refusal left a row · J4 idempotency is keyed on the REQUEST: identical bytes return the same job, a substituted
payload or a changed workspace or worker key under the same correlation is rejected · J5 claim is bound to tenant,
connector and correlation, hands back the sealed payload exactly once, counts the attempt, and denies the duplicate ·
J6 terminal only from claimed — pending completes and fails as `not_claimed`, a terminal row cannot transition again by
either wrapper, a free-form reason is refused, and only the deadline may say `expired` · J7 both terminal rows hold no
sealed material, and two completed jobs opened no run, wrote no fact, promoted no evidence, touched no credential and
consumed no pending row · J7b a retry AFTER the completion consumed the state still returns the existing job, which is
the only assertion that pins idempotency being resolved before the authorize-half gate · J8 expiry: an expired job is
unclaimable and uncompletable, the discovery path retires it and
clears its code, the sweep takes the rest, a stale CLAIM keeps its status but loses its sealed code, and an expired
correlation is never revived · J9 the constraints, not the wrappers — a terminal row cannot regain a payload, a job
cannot outlive the ceiling, one correlation cannot hold two jobs, and a cross-tenant connector, foreign redirect and
non-Slack provider are all impossible to insert directly · J10 the customer read declares exactly five bounded fields
and none protected; an owner sees status, an editor and another tenant's owner see nothing, and an authenticated session
can neither read nor write the table nor claim a job · J11 no refusal echoes a redirect, workspace, worker key, sealed
bytes or the caller's own reason string.
