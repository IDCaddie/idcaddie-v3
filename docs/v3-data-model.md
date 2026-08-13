# ID Caddie v3 Data Model (Proposed)

Supabase/Postgres relational schema for the v3 MVP. Maps legacy Firestore shapes (see [current-product-map.md](./current-product-map.md) §3) onto explicit tenant-scoped tables with RLS (see [v3-security-model.md](./v3-security-model.md)).

> **Status:** The skeleton already exists at `supabase/migrations/0001_core_schema.sql` (17 tables, RLS enabled, `is_tenant_member`/`has_tenant_role` helpers). This document is the design of record and lists **proposed changes** to that skeleton. Per project rules, the SQL is **not edited yet** — changes below are documented for approval first.

## Design principles
- Every customer-owned row has `tenant_id uuid not null references tenants(id)`. Tenancy is enforced in Postgres RLS, **not** by separate projects (the legacy model) and **not** by frontend filtering.
- Prefer explicit columns over JSON blobs; retain raw source payloads in `raw_payload jsonb` only where the import source shape must be preserved.
- Identity, ownership, and access are first-class relations (no denormalized permission copies — RLS computes access by join).
- Audit is append-only at the DB layer.

## Entity overview
```
tenants ─┬─< tenant_memberships >─ profiles (auth.users)
         ├─< organizations ─< organization_memberships
         ├─< apps ─┬─< app_users ─< app_user_identity_matches >─ people
         │         ├─< license_rules ─< license_evaluations
         │         └─< app_contracts >─ contracts
         ├─< files ─< invoices
         └─< audit_logs
```

## Tables

### Tenancy & identity
- **tenants** `(id, name, slug unique, status, timestamps)` — one row per customer (Flywheel, Omnicom, …). Replaces project-per-tenant.
- **profiles** `(id → auth.users, email, full_name, timestamps)` — app user identity.
- **tenant_memberships** `(id, tenant_id, user_id, role, status, unique(tenant_id,user_id))` — site role per tenant. `role ∈ {owner, admin, editor, viewer}`. Maps legacy `token.role` (+ new `owner`).
- **organizations** `(id, tenant_id, parent_org_id, name, type, timestamps)` — agency/org hierarchy (Omnicom → agencies). **Net-new**: legacy has no org tier.
- **organization_memberships** `(id, organization_id, user_id, role, unique(organization_id,user_id))` — `role ∈ {manager, viewer}` → v3 `org_manager`/`org_viewer`. Replaces legacy groups for org-scoped access.

### Apps & contracts (source of truth)
- **apps** `(id, tenant_id, name, vendor_name, category, status, source_of_truth_type, technical_owner_user_id, business_owner_user_id, procurement_owner_org_id, paying_org_id, responsible_org_id, notes, timestamps)` — maps `IDCApps`. Ownership/chargeback as explicit FK columns (legacy kept these in `fields.*`).
- **contracts** `(id, tenant_id, vendor_name, contract_name, status, start_date, end_date, renewal_date, notice_deadline, total_cost, currency, billing_frequency, owner_user_id, procurement_org_id, paying_org_id, renewal_responsibility, timestamps)`.
- **app_contracts** `(app_id, contract_id, tenant_id, relationship_type, PK(app_id,contract_id))` — link table. Replaces legacy `linkedDocs` maps + transitive group propagation (`linkedResourceSync.js`).

### People & identity reconciliation
- **people** `(id, tenant_id, primary_email, full_name, employee_status, department, title, manager_email, source, raw_payload, timestamps)` — unified directory. Replaces `people/{base64(email)}` + `_summary`/`_appTiers` (those become views/queries).
- **identity_accounts** `(id, tenant_id, person_id, provider, external_id, email, status, raw_payload, timestamps)` — IdP accounts.
- **app_users** `(id, tenant_id, app_id, external_user_id, email, display_name, status, license_type, last_active_at, source, raw_payload, timestamps)` — per-app accounts (`IDCApps/{id}/users`). Drives stale/unmanaged reports.
- **app_user_identity_matches** `(id, tenant_id, app_user_id, person_id, match_method, confidence, reviewed_by, reviewed_at, unique(app_user_id,person_id))` — email/local-part matching ladder from `watchUserUpdated.js`/`rebuildPeopleCollection.js`.
- **person_account_links** `(id, tenant_id, person_id, identity_account_id, app_account_id, method, confidence, status, rationale, decided_by, decided_at, created_at)` — **0082**, the cross-source identity graph: the evidence-bearing edge from a **provider account** (an `identity_accounts` row *or* an `app_accounts` row — exactly one, by CHECK) to a **person**. Same-tenant composite FK on all three endpoints; at most one `accepted` person per account, unconstrained on the person side. `method ∈ {manual, normalized_email, accepted_account_match}`; everything lands `proposed` and a human decides. RLS on, zero policies — written only by `product_propose_person_links` / `product_decide_person_link`. **`identity_accounts.person_id` (0001) is deliberately left unwritten; this table is authoritative.**

### Licensing & spend
- **license_rules** `(id, tenant_id, app_id, name, license_type, expression_json, active, timestamps)`.
- **license_evaluations** `(id, tenant_id, app_id, app_user_id, license_rule_id, license_type, is_billable, evaluated_at, explanation)` — **service-role write only** (computed).
- **files** `(id, tenant_id, storage_path, original_filename, file_type, document_type, uploaded_by, processing_status, created_at)` — `storage_path` MUST be tenant-scoped.
- **invoices** `(id, tenant_id, vendor_name, invoice_number, invoice_date, amount, currency, file_id, app_id, contract_id, created_at)` — chargeback.

### Audit
- **audit_logs** `(id, tenant_id, actor_user_id, action, resource_type, resource_id, before_json, after_json, ip_address, user_agent, created_at)` — append-only (INSERT-only RLS, no UPDATE/DELETE).

---

## Proposed changes to `0001_core_schema.sql` (for approval — not yet applied)

> **#1 and #2 are now IMPLEMENTED** in `supabase/migrations/0002_org_scoped_rls.sql` + `0003_org_access_union.sql` (additive — `0001` is unchanged) and verified by `supabase/tests/org_rls_test.sql`. The remaining items (#3–8) are still open.
>
> **MVP access model (the SQL best-practice split):**
> - **Stewardship / WRITE is single-org:** `apps.responsible_org_id`, `contracts.procurement_org_id`. Only a manager of the steward org (or a tenant editor+) may write.
> - **READ is multi-org / relationship-derived** (`0003`): an org user reads an **app** if their org is its `responsible_org_id` **OR** `paying_org_id` **OR** `procurement_owner_org_id`; a **contract** if their org is its `procurement_org_id` **OR** `paying_org_id`. This is what makes chargeback work when procurement is centralized (e.g. Omnicom): the agency that *pays* can see the resource even if it isn't the steward.
> - **Tenant binding:** every org FK used for read or write is validated same-tenant by the `enforce_owning_org_tenant` trigger (`0003` broadened it to all access-relevant columns). `0002` also closed a pre-existing `0001` tenant-admin→owner self-promotion.
> - **Future enterprise model** may replace these columns with a `resource_org_links` relationship table (`relation ∈ responsible|paying|procurement|consuming`) + recursive `parent_org_id` org hierarchy; access then derives from links (read = any relation, write = `responsible`).

1. ✅ **Org roles in helper coverage.** Done in `0002`: `is_org_member`, `has_org_role`, `has_org_role_in_tenant`, `is_tenant_participant`; `organization_memberships` got admin-manage + own-read policies.
2. ✅ **Resource→org scoping enforced.** Done in `0002`: org-scoped read + manage policies on `apps`/`contracts`, with exact-org checks (no cross-org/cross-tenant escalation) + the owning-org tenant trigger.
3. **Append-only audit hardening.** Skeleton has a SELECT policy and "no update/delete policies" comment (`:323-325`) — but with RLS enabled and no INSERT policy, inserts also fail for normal roles (writes come via service role). Document explicitly: audit writes are service-role only; add a revoke of UPDATE/DELETE even from table owner where feasible, and a retention/archive policy (legacy hard-purged at 90 days — **do not** port that).
4. **Encrypted credential store (deferred connectors, but model now).** Add a `connector_credentials` table reachable **only** via service-role / `SECURITY DEFINER` RPC, secrets stored via Supabase Vault/pgsodium — never the plaintext `IDCApps/{id}/private` pattern. Keep out of MVP tables but reserve the boundary.
5. **Tokens hashed.** Any token table (API keys, future ingest) stores `token_hash` + short prefix only (legacy already did this for API keys/SCIM — adopt universally; do NOT port plaintext ingestor/inbound tokens).
6. **Non-destructive import staging.** Add a `staging_*`/import-batch concept (or `import_runs` table) so people/app-user imports diff against current state instead of full-replace + hard-delete (legacy `onFileLinkedToApp.js:283-290`). At minimum, soft-delete + audit every add/remove.
7. **`app_users` last-active + utilization** columns are sufficient for stale/unmanaged reports; confirm indexes on `(tenant_id, app_id, status, last_active_at)` for the insights queries.
8. **Group vs org decision.** Legacy "groups" (`manager|viewer` + resource `groups[]`) are folded into **organizations + organization_memberships** for the MVP (org-scoped governance). If finer-grained per-resource sharing is needed later, add a `resource_grants` join table — deferred, not built speculatively.

> Tests that must pass before UI (`supabase/tests/rls_test_plan.md`): cross-tenant read/write denial, viewer-cannot-edit, editor-cannot-manage-members, **org_manager scoped to own org only** (needs changes #1–2), audit immutable, files tenant-isolated, credentials not user-readable.
