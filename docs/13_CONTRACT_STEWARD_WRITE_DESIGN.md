# 13 · Contract Steward Write Design

**Canonical source for: how contract *writes* (create / edit) will work — before any write UI lands.**
This is a **design + guardrail** doc. **Update (PR #29):** the write **RLS authority** and the
**audit-on-write** trigger now both exist; **the write UI and the write route/DAL still do not.**
RLS authority model: [02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md)
(§3 read-vs-write split, §4 audit immutability, §4a audit-on-write, §4b no-hard-delete, §5 tenant-integrity trigger). Risks: RISK-002 (open),
RISK-016 / OMC parity (open). OMC/Flywheel cutover remains **blocked**.

> **Verified finding (not a guess):** the contract write **RLS authority already exists** — it was
> shipped in `0002` and split into `INSERT`/`UPDATE` (no `DELETE`) by `0004`. A live `pg_policies`
> dump on a fresh `0001`–`0010` DB confirms exactly: `editors insert/update contracts`
> (`has_tenant_role` owner/admin/editor) **+** `org managers insert/update org contracts`
> (`has_org_role_in_tenant(procurement_org_id, …, ['manager'])`), **0** `DELETE`/`ALL` policies, and the
> `enforce_owning_org_tenant` trigger covering `procurement_org_id` + `paying_org_id`. **This already
> matches the recommended model below.** So the design gap is **not** the policy. **As of PR #29 the
> *audit-on-write* trigger also exists** (`0010` — §4 below). The remaining gap is the *application write
> path* (server action + input validation) and the *UI* — neither exists yet.

## 1. What contract writes will be allowed
- **Create (INSERT) a contract** and **edit (UPDATE) a contract's own fields** (name, vendor, dates,
  cost, status, owning-org columns) — subject to the write-authority rules in §2.
- **No hard delete, ever** (§5). Archive / soft-delete is a **separate** future design (out of scope, §9).
- **No `app_contracts` (app↔contract link) writes** here — that is its own future surface (out of scope).

## 2. Who can write — the authority model (already enforced by RLS)
Writes are **single-org / steward** (unlike reads, which are multi-org / related — [02 §3](./02_SECURITY_AND_RLS.md)).

| Actor | Create | Update | Mechanism (live policy) |
|---|---|---|---|
| Tenant **owner / admin / editor** | ✅ any tenant contract | ✅ any tenant contract | `has_tenant_role(tenant_id, ['owner','admin','editor'])` (`editors insert/update contracts`, `0004`) |
| Org **steward** = `manager` of the contract's `procurement_org_id` | ✅ contract whose `procurement_org_id` is their org | ✅ contract stewarded by their org | `has_org_role_in_tenant(procurement_org_id, tenant_id, ['manager'])` (`org managers insert/update org contracts`, `0004`) |
| Tenant **viewer** | ❌ | ❌ | no write policy (read-only) |
| Org **viewer** of `procurement_org_id` | ❌ | ❌ | write policy requires `manager`, not `viewer` |
| Member of **`paying_org_id`** only (not procurement, not tenant editor) | ❌ | ❌ | **read-only** — see §3 |
| **Related-org reader** (sees the contract via the union read) | ❌ | ❌ | read ≠ write — see §3 |
| **Other-tenant** user | ❌ | ❌ | every policy is `tenant_id`-bound; no membership → false |

**Cross-tenant writes are double-guarded:** the policy `WITH CHECK` keys on the row's `tenant_id`
membership, and the `enforce_owning_org_tenant` **trigger** (`BEFORE INSERT/UPDATE`) rejects any
`procurement_org_id` / `paying_org_id` whose organization lives in another tenant — for *every* writer,
including a `BYPASSRLS` `service_role`.

## 3. Why read access must NOT imply write access
The read model is deliberately broader than the write model (chargeback visibility under centralized
procurement — [02 §3](./02_SECURITY_AND_RLS.md)):
- **`paying_org_id` grants READ only.** An agency that *pays* for a contract can see it (so chargeback
  works) but must **not** edit it — the accountable steward is the **procurement** org. The write
  policies key **only** on `procurement_org_id` (org path) or tenant-editor role; nothing keys on
  `paying_org_id`. Proven today by **T21** (a paying-related agency's `UPDATE` affects 0 rows).
- **Related-org / union read** (`procurement_org_id` OR `paying_org_id`, `0003`) is a *read* union only.
  Being able to *see* a contract never confers write. Write authority is the narrow steward set in §2.
- **`procurement_org_id` is the write anchor.** It is the single accountable owning org for edits;
  `paying_org_id` and any other related org are read signals, not write grants.

## 4. The application write PATH + audit (audit DONE in `0010`; the write PATH is still the open part)
The RLS *authority* exists **and the audit trigger now exists**; the remaining work is the *write path*,
**gated by that existing RLS** (never bypassing it):
- **Server action / route handler uses the user-scoped anon server client** (`@/lib/supabase/server`) —
  the same client the read DALs use. RLS enforces who may write; the app **never** uses a service-role /
  admin client in the request path, and **never** filters for authorization on the client.
- **Input validation at the trust boundary** (required fields, types, enum/status whitelist) — but
  validation is **not** authorization; RLS is. Do not infer a tenant_id from the client; the row's
  `tenant_id` must come from the actor's resolved tenant context, and the trigger + `WITH CHECK` reject
  anything cross-tenant.
- **Audit on write — DONE (`0010`, PR #29):** `audit_logs` is **append-only** (`reject_audit_mutation`,
  `0002`) and has **no `authenticated` INSERT policy**, so the anon app client **cannot** write it
  directly. So the audit row is written **DB-side** by the `SECURITY DEFINER` `AFTER INSERT OR UPDATE`
  trigger `contracts_audit_on_write` (function `public.audit_contract_write`) — capturing
  `actor = auth.uid()` (the caller, **not** the owner/service-role), `action` =
  `contract.created`/`contract.updated`, `resource_id` = `NEW.id`, and a curated non-sensitive
  `after_json` allowlist — **not** a service-role app route. Because it is **AFTER**, only DB-accepted
  writes audit; RLS-denied / integrity-rejected writes do not. See [02 §4a](./02_SECURITY_AND_RLS.md);
  proven by `org_rls_test.sql` **T31/T32**. **A write-path PR therefore inherits auditing for free** — it
  must NOT add a service-role audit route, and must NOT weaken/duplicate this trigger.
- **No new privilege:** the write path adds no policy, no `FOR ALL`, no `DELETE`, no service-role.

## 5. Preserving the no-hard-delete posture (`0004`)
`contracts` has **no `DELETE` policy and no `FOR ALL` policy** (verified — 0 of each). A `DELETE`
affects 0 rows for every `authenticated` role; this must stay true. The write path adds **INSERT +
UPDATE only**. Removing a contract, if ever needed, is **archive / soft-delete** (a `status`/`archived_at`
column + UPDATE, never a row delete) — a separate future design (§9). **Never** re-introduce `FOR ALL`
or a `DELETE` policy on `contracts` (it silently grants hard-delete — [02 §4b](./02_SECURITY_AND_RLS.md),
[07 red flags](./07_P0_REVIEW_CHECKLIST.md)).

## 6. Future policy sketch (REFERENCE ONLY — already live; do NOT re-add)
This is the **current** `0004` shape, shown so a future implementer does **not** re-create or weaken it.
A write-UI PR should rely on these as-is (and add only the *path* + *audit*):
```sql
-- ALREADY SHIPPED in 0004 — do not duplicate. Shown for reference.
-- INSERT: tenant editor+ OR steward (manager) of the new row's procurement_org_id.
create policy "editors insert contracts" on public.contracts
  for insert with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "org managers insert org contracts" on public.contracts
  for insert with check (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']));
-- UPDATE: same authority, USING (the existing row) + WITH CHECK (the new row) so a steward cannot
-- reassign a contract out of their org, and an editor cannot stamp a foreign-tenant org id.
create policy "editors update contracts" on public.contracts
  for update using (public.has_tenant_role(tenant_id, array['owner','admin','editor']))
  with check (public.has_tenant_role(tenant_id, array['owner','admin','editor']));
create policy "org managers update org contracts" on public.contracts
  for update using (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']))
  with check (public.has_org_role_in_tenant(procurement_org_id, tenant_id, array['manager']));
-- NO delete policy, NO FOR ALL. Tenant-bound org validation via enforce_owning_org_tenant trigger.
```
If audit is added, the **only** new SQL is the `SECURITY DEFINER` audit trigger (§4) — still no `DELETE`,
no `FOR ALL`, no service-role.

## 7. Exact tests a future implementation PR must prove (before UI ships)
Much is **already proven** by `org_rls_test.sql`; map to it and add only what's missing:
| Required proof | Status |
|---|---|
| Tenant **owner** can INSERT/UPDATE a tenant contract | add a positive INSERT/UPDATE case (editor-write covered indirectly; make it explicit) |
| Tenant **admin/editor** can INSERT/UPDATE (per design) | add explicit positive case |
| Org **steward** (manager of `procurement_org_id`) can INSERT/UPDATE | extend existing org-manager edit coverage with an explicit contract INSERT |
| **Paying-org** member CANNOT update (read ≠ write) | **already proven — T21** |
| **Unrelated** org member cannot update | add (mirror T3/T4 cross-org denial for contracts) |
| **Other-tenant** user cannot INSERT/UPDATE | **already proven — T14** (cross-tenant write denial) |
| **Cross-tenant `procurement_org_id`** rejected | **already proven — trigger T22/T23**; add a contract-INSERT variant |
| **Cross-tenant `paying_org_id`** rejected | **already proven — T22** |
| **Hard delete denied** on contracts | **already proven — T17/T24** |
| `app_contracts`/`app_users`/match-status reads still pass | **already proven — T28/T29/T30** |
| **Audit event created** on insert/update, exactly once, actor = the writer | **already proven — T31** (`0010` audit trigger; allowed INSERT/UPDATE audit once; denied/failed writes never audit) |
| **No `FOR ALL` / no `DELETE`** policy on `contracts`; `audit_logs` no direct write | **already proven — T32** (catalog: contracts 0 `DELETE`/0 `ALL`; `audit_logs` no INSERT/UPDATE/DELETE/ALL policy; trigger is `AFTER`, function is `SECURITY DEFINER`) |
| Server action uses anon client, **no service-role** | `check-auth-safety.sh` (grep for service-role in `src/app`) — already CI-enforced |

## 8. UI behavior (future)
- Server-rendered forms posting to a server action; the action calls the anon DAL write. A failed RLS
  write surfaces a generic "you don't have permission / could not save" — **no enumeration**, no leak of
  whether the row exists in another tenant.
- Edit/create controls are shown optimistically but **authorization is RLS** — never hide/show as the
  security boundary, and never trust a client-sent `tenant_id`/`procurement_org_id` for authority.
- No delete/archive button until the archive design (§9) lands. No `app_contracts` link/unlink controls.

## 9. Explicitly out of scope (this PR and the first write PR)
- Contract **archive / soft-delete** (separate future design).
- `app_contracts` (app↔contract link) **writes**.
- `files` / `invoices` / `license_*` reads or writes; `people` / `identity_accounts` changes.
- Any service-role usage; any hard delete; any `FOR ALL`.
- OMC/Flywheel cutover (stays **blocked**).

## 10. Honest status (do not overclaim)
- Contract write **RLS authority**: **already implemented** (`0002`/`0004`) — matches §2.
- **Audit-on-write**: **implemented** (PR #29 — `0010` `SECURITY DEFINER` `AFTER INSERT/UPDATE` trigger; §4; proven by T31/T32). A write-path PR inherits auditing — no service-role audit route.
- Contract write **UI / server-action / DAL**: **not implemented.** Contract create/edit **parity still missing**.
- Contract **archive / soft-delete**: **not implemented** (separate design).
- `app_contracts` writes: **not implemented.** Hard delete: **blocked** (`0004`) — stays blocked.
- **Next step:** the contract write **path** (server action on the anon client, gated by the existing RLS, land §7 tests first), then the contract create/edit **UI** matching the legacy workflow ([14 §3](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)).
- RISK-002: **open.** RISK-016 / OMC parity: **open.** OMC/Flywheel cutover: **blocked.** New paid-customer onboarding: **blocked.**
