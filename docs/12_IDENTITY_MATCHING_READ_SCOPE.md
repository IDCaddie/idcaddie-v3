# 12 · Identity / Account / Matching Read-Scope Design

**Canonical source for: how identity, account, and matching data may be safely *read* in
future PRs.** This is a **design + guardrail** doc. **Nothing here is implemented.** No identity
matching, no unmanaged-account report, no `identity_accounts` read, no `people` org-read exists.
RLS authority model: [02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md) (§3, §8, §8a). Risk: RISK-002
(open), RISK-016 / OMC parity (open). OMC/Flywheel cutover remains **blocked**.

> **Status of every surface below: `planned` / `deferred`.** This doc decides the *shape* a future
> implementation must take; it grants no access and adds no policy. A future PR that implements any
> of this must land the exact policy + the exact tests in §7 **before** any UI, and must be
> re-reviewed for tenant-wide leakage.

## 1. The product goal (why this is sensitive)
The next major unlock is **unmanaged-account / identity matching** — per-app, answer "which of this
app's accounts map to a real, managed person, and which are orphaned/unknown?" (legacy: `resolveUAR`,
stale-users, per-app `IDCApps/{id}/users`). That is genuinely useful to an **org-only** agency user
who manages an app. But the underlying data is a **tenant-wide employee + identity directory**, and
naïvely surfacing it would leak the whole company's people/identity records to an org-only user.

The design principle, in one line: **scope every identity/match view from the app / app_user side the
user can already read — never from the `people` or `identity_accounts` side.**

## 2. Tables involved, fields, and sensitivity
Schema: [v3-data-model.md](./v3-data-model.md) / `0001_core_schema.sql`. Current read scope:
[02 §8](./02_SECURITY_AND_RLS.md).

| Table | Current read | Anchor (what ties a row to an app?) | Sensitive fields |
|---|---|---|---|
| `app_users` | **org-scoped read** (`0007`, you can read the row iff you can read its `app_id`) | `app_id` → `apps` (org-readable) | `email`, `display_name`, `external_user_id` (the app's own roster) |
| `app_user_identity_matches` | **org-scoped read** (`0008`, PR #23 — you can read the row iff you can read its `app_user`) | `app_user_id` → `app_users` (org-readable) **and** `person_id` → `people` (tenant-only) | links an app_user to a **person**; `match_method`, `confidence`, `reviewed_by/at` |
| `people` | **tenant-only** (`is_tenant_member`) | **none** (not tied to any app) | `primary_email`, `full_name`, `manager_email`, `employee_status`, `department`, `title`, `raw_payload` — a full **HR directory** |
| `identity_accounts` | **default-deny** | **none** (ties to `person_id` → `people`, not to an app) | `email`, `external_id`, `provider`, `status`, `raw_payload` (IdP scrape — may hold tokens/scopes/groups) |

The decisive structural fact: **`app_user_identity_matches` has an app-side anchor (`app_user_id`);
`people` and `identity_accounts` do not.** Only the first can be org-scoped from a readable app. The
other two have no path from "an app I manage" to "a row I may read" without going through the
tenant-wide directory — so org-scoping them would *be* the leak.

## 3. What may be exposed to an org-only user, and what must not
**May be exposed (future, app-anchored, read-only):**
- `app_users` rows for apps the user can read — **already shipped** (`0007`, PR #21; roster on `/apps/[id]`).
- `app_user_identity_matches` rows whose `app_user_id` the user can read — **future** (§4/§5). This
  yields, per readable app_user: *is it matched?* (a match row exists), `match_method`, `confidence`,
  `reviewed_at`. Enough for a **matched / unmatched** signal.
- A **minimal derived status** (`matched` | `unmatched` | `orphaned`) per readable app_user, computed
  **server-side** via a **`security_invoker` view** (so the caller's RLS scopes it) — or a `SECURITY
  DEFINER` function that re-derives the caller's scope explicitly — returning only the enum, never the
  underlying person/identity rows. Note the SECURITY DEFINER scoping trap in §4.

**Must NOT be exposed to an org-only user:**
- The `people` directory (any `people` row not reachable as "a person matched to an app_user I can
  read", and even then only as an opaque `id`, never PII — see §6).
- `identity_accounts` rows (no app anchor; exposing them = tenant-wide IdP leak).
- Any cross-app correlation beyond the apps the user manages (naturally enforced because the anchor is
  the readable `app_user`).
- `raw_payload` on any table (arbitrary scraped data / possible secrets).

**Must remain tenant-only / admin-only:**
- The full `people` HR directory (a tenant-member or future tenant-admin surface — never org-only).
- `identity_accounts` (default-deny today; if ever surfaced, a **tenant-scoped** admin identity
  surface, gated on `is_tenant_member`, never org-only).

## 4. Avoiding the two leaks
**Avoid a full tenant `people` directory:** do **not** add an org-scoped read policy to `people`.
`people` has no owning app/org column, so there is no honest "related-org" scoping — any org policy
would either leak the whole directory or require inventing an ownership column we don't have. App-user
views show the **app_user's own** `display_name`/`email` (columns on `app_users`, *not* `people`); they
do not join to `people` for display.

**Avoid exposing unrelated identity accounts:** do **not** org-scope `identity_accounts`. There is no
app-side path to it. The matched/unmatched signal an org user needs comes from the **existence of a
match row** (app-anchored), not from reading the identity account.

**The "managed vs orphaned" nuance:** a richer classification ("matched but the person is
deactivated/orphaned") needs `people.employee_status` or `identity_accounts.status`, which are
tenant-only/default-deny. Do **not** expose those rows to get it. There are two ways to compute the
status enum server-side, and a **trap** between them:

- **Preferred — a `security_invoker` view** (Postgres 15+ `WITH (security_invoker = true)`) over the
  org-scoped reads (`app_user_identity_matches` joined to `app_users`): the **caller's** RLS applies to
  the underlying scans, so the result is automatically scoped to the app_users the caller can read. It
  cannot read the tenant-only status columns, so it yields `matched`/`unmatched` only — usually enough.
- **Only if you must read a tenant-only status column** (`people.employee_status` /
  `identity_accounts.status`) to distinguish `orphaned`: a `SECURITY DEFINER` function. **WARNING — a
  `SECURITY DEFINER` function runs as its OWNER and does NOT apply the caller's RLS.** An inner `EXISTS`
  over `app_users` (the §5 mechanism) therefore does **nothing** to scope it — it would return status
  for **every** tenant app_user, a tenant-wide leak of the matched/orphaned signal (the exact thing this
  design prevents). A definer MUST **re-derive the caller's readable-app_user scope explicitly inside
  the function** — e.g. restrict to app_users the caller may read via the same org-membership / apps-RLS
  predicate (`has_org_role_in_tenant`-style), or accept the allowed `app_user_id` set as an argument and
  validate it. In **all** cases the result must return **no** person/identity columns — only
  `{app_user_id, status}`.

Default to the `security_invoker` view; reach for `SECURITY DEFINER` only when a tenant-only column is
genuinely required, and then test the scoping explicitly (§7.7).

## 5. The org-scoped match-read policy — **IMPLEMENTED in `0008` (PR #23)**
This was the design's one concrete recommendation; **`0008` ships it verbatim** (proven by T30). One
org-scoped `SELECT` policy on `app_user_identity_matches`, mirroring `0007` (reuse `app_users` RLS via
`EXISTS`, with an **explicit tenant-bind** so the policy is self-sufficient — see T29h/T30h):

```sql
-- Shipped in 0008. Read a match row iff you can read its app_user (which is itself org-scoped).
create policy "org members read related app_user_identity_matches"
on public.app_user_identity_matches
for select using (
  exists (
    select 1 from public.app_users au
    where au.id = app_user_identity_matches.app_user_id
      and au.tenant_id = app_user_identity_matches.tenant_id   -- explicit tenant-bind (mirror 0007)
  )
);
-- SELECT only. Keep the tenant-member read (add one if matches need tenant-wide read). NO DELETE policy.
-- Writes (the matching job) run via service-role / SECURITY DEFINER, NOT org users — no org INSERT/UPDATE.
```

This grants nothing beyond "you can read the linked app_user", is tenant-bound by the explicit clause
+ the `0005` `auim` same-tenant FKs, and never references `people`/`identity_accounts`. It does **not**
let the org user read `people` or `identity_accounts` — those policies stay unchanged.

Explicitly **rejected** alternatives (and why): an org policy on `people` (no honest ownership column →
leaks the directory); an org policy on `identity_accounts` (no app anchor → tenant-wide IdP leak);
scoping a match via `person_id` (starts from the people side → the thing we're avoiding); embedding
`people`/`identity_accounts` joins in the app-user roster query (RLS would null them out for org users,
but the query *shape* invites a future maintainer to "just expose the name" — keep the join out).

## 6. Should `people` ever become org-scoped?
**Default answer: no.** Prefer **app-user-centric** views that never expose `people` directly. The only
identity an org-only user legitimately needs is *their app's account roster* (`app_users`, shipped) and
*whether each account is matched* (`app_user_identity_matches`, future). If a future product need truly
requires showing the **matched person's name** to an org-only user, that is a deliberate, separately
reviewed decision that must: (a) expose only the minimal field(s) for matched persons of *readable*
app_users, (b) do so via a **`security_invoker` view** (caller RLS scopes it) — or a `SECURITY DEFINER`
function that re-derives the caller's scope, per the §4 trap — returning only those fields (never the
`people` row), and (c) ship with tests proving an org user cannot enumerate unmatched/unrelated people.
Until such a need is approved, `people` stays **tenant-only** and app-user views show the app_user's own
fields.

## 7. Exact tests a future implementation MUST prove (before any UI)
A future identity/matching PR is **not allowed to ship UI** until all of these pass (extend
`org_rls_test.sql`; mirror the T28/T29 structure):
1. **Match read is app-anchored:** an org-only user reads `app_user_identity_matches` rows **only** for
   app_users they can read (i.e. apps they can read); **0** for unrelated apps.
2. **Cross-tenant:** other-tenant owner reads **0** of this tenant's match rows; org-only user reads
   **0** cross-tenant. Include a planted-FK-bypass corrupt-row check (like T29h) proving the explicit
   tenant-bind denies it.
3. **Non-member:** a pure non-member reads **0** match rows.
4. **No collateral read:** the new match policy must **not** grant read on `people` or
   `identity_accounts` — assert the same org-only user still reads **0** `people` and **0**
   `identity_accounts` after the policy lands.
5. **`person_id` is opaque:** holding a readable match row's `person_id` must **not** let the org-only
   user read that `people` row (people RLS unchanged → 0).
6. **No write surface:** no `DELETE` policy; org users cannot `INSERT`/`UPDATE` matches (0 rows); only
   service-role / definer writes.
7. **Derived-status view (if added):** querying it as an org-only user returns statuses for **exactly**
   the app_users that user can read — assert an **exact COUNT** against the readable-app_user set, **not**
   merely "no `people`/`identity_accounts` columns" (a leaky `SECURITY DEFINER` function passes a
   column-only check while returning every tenant row — see §4). Also assert it exposes no person/identity
   columns and cannot enumerate the directory. If a `SECURITY DEFINER` function is used, include a test
   that **fails** for a naive (unscoped) definer — i.e. an org-only user must get only its readable
   app_users' statuses, never all tenant rows.
8. Existing `app_contracts` (T28) and `app_users` (T29) org-read still pass; `people`/`identity` default
   posture (T27 27a/27b) unchanged for tenant owner.

## 8. Guardrails — proven by the suite
PR #23 implemented §5 (migration `0008`) and added **T30**; the `app_user_identity_matches` default-deny
assertions in T27 27a / T29 29f were dropped (they would now be wrong). The safe posture is pinned by:
| Guardrail (today) | Proven by |
|---|---|
| Tenant **owner** reads 0 `identity_accounts` (default-deny) | **T27 27a**, **T30 30a** |
| Org-only user reads 0 `people` (tenant-only) | **T27 27b**, **T29 29f**, **T30 30b** |
| Org-only user reads 0 `identity_accounts` (default-deny) | **T29 29f**, **T30 30b** |
| Org-only user reads `app_user_identity_matches` **only** for readable app_users; a match read grants no `people`/`identity_accounts` read | **T30 30b–30d** (cross-tenant/non-member 30e; corrupt-row 30h) |
| Org-only user reads `app_users` for readable apps (`0007`) | **T29 29b–29d**, **T30 30g** |
| `app_contracts` org-read (`0006`) still holds | **T28**, **T29 29g**, **T30 30g** |
| `app_user_identity_matches` has **no `DELETE`** policy (delete denied) | **T30 30f** |
| No service-role assumption (suite runs as `authenticated`) | whole suite |

## 9. Honest status (do not overclaim)
- `app_user_identity_matches` org-read (match **status**): **implemented** (`0008`, PR #23 — §5; T30). Status only, no PII.
- Identity matching **algorithm**: **not implemented** (matches are written by a future server-side job).
- Unmanaged-account / UAR / stale-users report: **not implemented.**
- Managed/orphaned/deactivated status: **not implemented** (needs §4's `security_invoker` view; not built).
- `people` merge: **not implemented.** Provisioning / deprovisioning: **not implemented.**
- `identity_accounts` read: **not implemented** (default-deny).
- `people` org-read: **not implemented** (tenant-only; this design recommends it stays that way).
- RISK-002: **open** (narrowed for `app_contracts`/`app_users`/`app_user_identity_matches`). RISK-016 / OMC parity: **open.**
- OMC/Flywheel cutover: **blocked.**
