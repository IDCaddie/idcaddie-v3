# 34 · OMC Legacy → v3 Data Migration Plan

**Canonical plan for doc 17 blocker-sequence item #4** ([30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)): move the
live OMC app's data (legacy DB/Firestore + Storage objects) into v3 **safely** — advancing
[17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) box **16** (old-app freeze / cutover + data-migration
plan) and §3's "No OMC data-migration plan" hard blocker. **Planning only — this builds no migration code and
runs no migration.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **OMC legacy data migration plan is prepared, not executed.** This doc adds no migration tooling, code,
>   migration, or script.
> - **No production project was touched. No staging data was mutated by this PR.** **No real OMC customer data
>   is included** — every identifier here is illustrative/synthetic.
> - **No secrets, passwords, anon keys, cookies, or JWTs are recorded.**
> - **No doc 17 §5 box is ticked here.** **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not
>   automatically production-ready. Storage completion is necessary but not sufficient for cutover.**
> - **Migration follows the build.** You can only migrate into a surface that is **built + hosted-verified**
>   ([33](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md)); migrating into an unbuilt/unverified surface is premature
>   (§3). **Never** migrate via `local_demo.sql` (RISK-015); **never** migrate connector secrets before the vault
>   (RISK-007).

---

## 1. Legacy OMC data sources to migrate (Task 1)

Inventory from the legacy OMC app (DB/Firestore records + Storage objects). **Synthetic placeholders only here**
— the real export is the human discovery step (Phase A):

| Legacy source | Contains |
|---|---|
| Tenants / companies | the customer org(s) (OMC + any sub-orgs) |
| Organizations / groups / BUs | procurement/paying/agency orgs, group hierarchy |
| Users + memberships/roles | accounts + tenant/org role assignments |
| Apps (SaaS inventory) | managed SaaS apps + their owning/responsible/paying/procurement orgs |
| Contracts | contract records + parity fields + owning orgs |
| App↔contract links + cost allocation | which contract covers which app; allocation |
| App users (per-app accounts) | per-app user roster + match status |
| People / identity accounts + matches | identity directory + app-user↔identity matches |
| Invoices / spend | invoices, spend, proration/allocation |
| License rules / evaluations | rule definitions + ELU/waste results |
| Files (metadata + **bytes**) | contract PDFs + file metadata; the **Storage objects** themselves |
| Audit / history | change history, contract audit, file/AI history |
| Settings | company/tenant settings, report schedules |
| Connector configs / **secrets** | connector setup + credentials (**secrets — do NOT migrate; RISK-007**) |

---

## 2. Map each legacy source → v3 target (Task 2)

v3 has all 17 tables; **auth identities live in Supabase Auth (`auth.users`)**, not a migration table —
`public.profiles` references them.

| Legacy source | v3 target | Notes |
|---|---|---|
| Tenants / companies | `public.tenants` | one row per customer org |
| Orgs / groups / BUs | `public.organizations` (`parent_org_id`) | hierarchy traversal deferred (RISK-004) |
| Users | **Supabase Auth `auth.users`** + `public.profiles` | Auth users created via Auth admin (not a SQL insert) |
| Memberships/roles | `public.tenant_memberships`, `public.organization_memberships` | role + `status='active'` |
| Apps | `public.apps` | `responsible_org_id`/`paying_org_id`/`procurement_owner_org_id` |
| Contracts | `public.contracts` | `procurement_org_id`/`paying_org_id`; parity fields (`0011`, partial [15]) |
| App↔contract links | `public.app_contracts` | same-tenant composite FK (`0006`) |
| App users | `public.app_users` | per-app roster |
| People / identity accounts | `public.people`, `public.identity_accounts` | — |
| App-user↔identity matches | `public.app_user_identity_matches` | — |
| Invoices / spend | `public.invoices` | — |
| License rules / evaluations | `public.license_rules`, `public.license_evaluations` | — |
| File metadata | `public.files` (`storage_path`, `storage_bucket`, `content_type`, `byte_size`, `sha256`, `contract_id`) | row first, then the object |
| File **bytes** | **Supabase Storage** `contract-files` bucket, path `contracts/{tenant_id}/{file_id}.pdf` | private bucket (done+verified); needs the upload/loader path |
| Audit / history | `public.audit_logs` | **append-only** (`reject_audit_mutation()`, `0002`) — see §5 |
| Settings | (no settings table) | **blocked-until-built** (admin/settings — doc 33 T8) |
| Connector configs / secrets | (none) | **blocked — RISK-007; secrets never migrated to a column** |

---

## 3. Currently impossible / blocked-until-built (Task 3)

The v3 *table* may exist, but migrating data for a workflow whose **surface is not built + hosted-verified** is
premature — you would load data no UI can show or reconcile. Migrate **only** into built+verified surfaces
(per [33](./33_REQUIRED_WORKFLOW_PARITY_BUILD_PLAN.md)); defer the rest to land **with** its build PR.

| Area | Blocker | Migrate when |
|---|---|---|
| File **bytes** | upload/loader path not built (boundary done, doc 33 T3) | after T3 (upload action) ships + verified |
| Invoices / spend | not surfaced (schema only) | after T6 invoices surface |
| License rules / evaluations | not built (schema only) | after T6 license surface |
| Identity matching / people directory | partial read; directory not built | after T5 |
| Audit history (full) | append-only; no audit UI; some history has no v3 home yet | with T8 audit UI + a defined history model |
| Settings | no settings table/UI | after T8 admin/settings |
| Connector configs / **secrets** | **RISK-007 vault not built** | after the vault (doc 33 T9); **secrets never migrated as data** |
| Reporting artifacts / schedules | not built | after T7 (if persisted at all — confirm via doc 18) |

**Built + hosted-verified surfaces** (the only migration targets allowed today, **after** items #1/#2 run green):
tenants, orgs, memberships, apps, contracts, app↔contract links, app users, people/identity + matches (read
surfaces), and `files` **metadata** (bytes deferred to T3).

---

## 4. Migration phases (Task 4)

| Phase | What | Safety |
|---|---|---|
| **A. Discovery / export inventory** | Inventory every legacy source + counts (per tenant/object type); define the export schema. | Read-only on legacy; **encrypted, time-boxed export** (§7); no real data in the repo. |
| **B. Schema mapping** | Map legacy fields → v3 columns (§2); define the **stable legacy-id → v3-id mapping** table; flag blocked-until-built areas (§3). | Mapping doc only; reviewed. |
| **C. Dry-run transform** | Transform a legacy export into v3-shaped rows **offline** (no DB writes); validate types/FKs/tenant scoping; produce a diff/preview. | No DB mutation; preview only; idempotent design. |
| **D. Staging load** | Load the transformed **synthetic-or-redacted** set into **staging** only, tenant-scoped, via the trusted out-of-request loader. | Staging only; ref-confirmed; non-destructive upsert; never production. |
| **E. Validation / reconciliation** | Run the §5 reconciliation against staging + the deployed app (items #1/#2). | Read-only checks; recorded evidence (no secrets). |
| **F. Rollback / rehearsal** | Rehearse rollback (DB + Storage) in staging from a restore point; prove it. | Staging only; restore-point first. |
| **G. Production migration window** | Old-app **freeze** → final export → transform → production load → reconcile, under explicit approval + a maintenance window (doc 20). | **Separate, separately-approved**; backup/restore point; stop/rollback rules. |
| **H. Post-cutover validation** | Re-run reconciliation + smoke tests against production; monitor. | Read-only; rollback ready. |

Phases A–F are pre-cutover (staging). **G/H are cutover-gated and require doc 17 §5 + OMC signoff** — not done here.

---

## 5. Reconciliation checks (Task 5)

Run after each load (staging, then production); **every** check must pass, recorded with reviewer initials, no
secrets:

- **Row counts by tenant + object type** — legacy vs v3 per `tenant_id` and per table (tenants/orgs/memberships/
  apps/contracts/links/app_users/people/identity/matches/files/invoices/license).
- **Referential integrity** — every FK resolves; the **same-tenant composite FK** holds (no cross-tenant
  `app_contracts`/`files`/child references — the `0005`/`0006`/`0012` `(ref, tenant_id)` boundary).
- **File byte counts + checksum** — object count matches `files` rows; for each object, `byte_size` matches the
  stored object size and **`sha256` matches** the recomputed checksum of the migrated bytes.
- **Contract/app/user relationship counts** — app↔contract link counts, app-user roster counts, identity-match
  counts match legacy per tenant.
- **Permission / RLS spot checks** — a synthetic member of tenant A reads only tenant A; cross-tenant denied;
  the `0015` `files` grant present (ties to the item-#1 verifier R3/R4/R5).
- **Audit / history preservation** — see §"audit strategy": history is migrated into the append-only
  `audit_logs` (or a defined history record) and is **not** mutable post-load; no unsafe 90-day purge unless
  `deprecated-approved`.

---

## 6. Non-destructive migration rules (Task 6)

- **No destructive overwrite without a preview** — every load is preceded by a dry-run diff/preview (Phase C);
  no `delete`/`truncate`/blind overwrite of existing rows.
- **Idempotent upserts where safe** — keyed on the stable legacy-id → v3-id mapping, so a re-run converges
  (no duplicates, no clobbering). For append-only `audit_logs`, **insert-once** (no upsert/overwrite).
- **Tenant-scoped import boundaries** — every row carries the correct `tenant_id`; the composite FKs reject any
  cross-tenant reference at the DB, not just RLS.
- **Staged review before production** — A–F complete + reconciled in staging before any production load (G).
- **Rollback plan** — a DB + Storage restore point before each load; rehearsed (Phase F); production rollback
  documented before the window (G).

---

## 7. Security / privacy requirements (Task 7)

- **No secrets in the repo** — no DB/connection strings, service-role keys, tokens, or passwords committed.
- **No real customer data in docs** — only synthetic/illustrative IDs; the real export never enters the repo.
- **Encrypted temporary storage for exports** — if an export is staged, it is **encrypted at rest**, access-
  controlled, **time-boxed, and deleted** after the load; never committed.
- **Least-privilege credentials** — the migration loader is a **trusted, isolated, out-of-request job** with the
  minimum grants for the load; **NO service-role on any app/browser/request path** (RLS stays the request-path
  boundary); reads use least-privilege.
- **Audit trail for migration execution** — who ran each phase, when, against which project (ref-confirmed),
  with the reconciliation result — recorded as evidence (no secrets).
- **Connector secrets are NOT migrated** — they require the vault (RISK-007); never store a connector secret in
  a Postgres column / generated types / logs.

---

## 8. Required migration tooling PRs (named, NOT created — Task 8)

Each is a **separate future PR**, reviewed, with hard staging guards (mirroring the verifiers' ref checks),
no committed secrets, and tests:

1. **Export/inventory tool** — read-only legacy export + a counts inventory (Phase A); encrypted output.
2. **Transform/mapping tool** — offline legacy→v3 transform + the legacy-id→v3-id mapping + dry-run diff (B/C);
   no DB writes.
3. **Staging loader + reconciliation tool** — tenant-scoped non-destructive upsert into **staging** (ref-guarded)
   + the §5 reconciliation report (D/E). The **file-bytes loader is gated on doc 33 T3** (the upload path).
4. **Rollback tool** — DB + Storage restore + verification (F). 

None of these is created here. An agent never runs a migration or seeds hosted data.

---

## 9. Evidence required before doc 17's migration box (Task 9)

Box 16 (and the §3 data-migration blocker) is satisfiable **only** when all are recorded (no secrets, no real
data in the repo):

- The Phase A discovery inventory + the Phase B mapping (reviewed).
- A green Phase C dry-run + Phase D staging load, with the §5 reconciliation **all-pass** (counts, integrity,
  **file byte/checksum**, relationship counts, RLS spot checks, audit preservation).
- A **rehearsed rollback** (Phase F) with evidence.
- A documented old-app **freeze / cutover plan** (cutoff, freeze window, switchover, fallback) for Phase G.
- **OMC acceptance signoff** of the migration plan + the staging reconciliation.
- Confirmation: no secrets, no real customer data in the repo; least-privilege loader; no service-role on a
  request path.

Even with all of the above, **box 16 alone does not authorize cutover** — every doc 17 §5 box must be true.

---

## 10. Risk posture

**RISK-001 remains OPEN** — a plan, not migrated data. **RISK-015** (never seed/migrate via `local_demo.sql`),
**RISK-007** (vault; no connector-secret migration), **RISK-002/013/016** remain open. **Cutover remains
BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for
cutover.** No production/staging mutation, no hosted command, no real OMC data, no secrets in this PR. OMC/
Flywheel is a paying production **replacement, not a pilot**.
