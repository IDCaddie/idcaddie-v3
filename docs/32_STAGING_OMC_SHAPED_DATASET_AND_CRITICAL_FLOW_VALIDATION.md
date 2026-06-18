# 32 · OMC-Shaped Staging Dataset + Critical-Workflow Validation

**Canonical plan for doc 17 blocker-sequence item #2** ([30](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)): load an
**OMC-shaped synthetic dataset** in staging and **validate the critical workflows of the currently-implemented
surfaces** against it — advancing [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) boxes **7, 9** (and
feeding box 8). This is a **runbook**; it loads no data and runs no validation.

> ## ⚠️ STATUS BANNER (do not remove)
> - **OMC-shaped staging dataset and critical-workflow validation are PREPARED, not executed.**
> - **No production project was touched. No staging data was mutated by this PR.** No seed was run; no Auth user
>   or fixture was created.
> - **No secrets, passwords, anon keys, cookies, or JWTs are recorded.**
> - **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready.**
> - **Storage completion is necessary but not sufficient for cutover** — this item is a *different* §5 box set.
> - **Runbook only — no committed runnable seed script.** A bare `.sql` has no runtime project guard (unlike the
>   throwaway-container `seed-local-demo.sh` or the ref-guarded `.mjs` verifiers), so the seed lives here as a
>   **template a human reviews + applies deliberately in the staging SQL editor**, never a one-command runnable.
>   (This is the hosted seed/runbook RISK-015 said to revisit — it is **separate from** `supabase/fixtures/local_demo.sql`,
>   which must NEVER be hosted-applied.)

---

## 1. What "OMC-shaped staging dataset" means

A **synthetic, OMC-realistic, multi-tenant** dataset — large enough to exercise the implemented surfaces with
*shape* (multiple orgs/roles/apps/contracts/links/app-users + identity matches), **not** the 1-each
`local_demo.sql` shape — used to validate that the deployed staging app shows **correct, tenant-scoped** data.
It is **all synthetic** (no real customer data), **staging-only**, and **aligned with the [31 §4](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md) / [26 §5](./26_STORAGE_REST_VERIFICATION_RUNBOOK.md) synthetic
fixture IDs** so the same synthetic Auth users serve both item #1 (Auth/tenant-context) and item #2.

It is **not** an OMC data migration (that is blocker-sequence rank 4 / [17 §3](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md));
no real OMC corpus is loaded. It does **not** ship any not-built surface; it only feeds what already exists.

---

## 2. Minimum synthetic entities (to exercise current surfaces)

≥2 tenants for cross-tenant isolation. Counts are *minimums to give shape*; all IDs synthetic.

| Table | Minimum | Purpose / surface exercised |
|---|---|---|
| `tenants` | 2 (A "Acme", B "Globex") | cross-tenant isolation; tenant context |
| `profiles` | ~6 (one per synthetic Auth user) | session identity (Auth users set up separately — §8) |
| `tenant_memberships` | A: owner/admin/editor/viewer; B: owner | role-based behavior; `is_tenant_member` reads |
| `organizations` | A: procurement-org, paying-org, a BU (+ B: 1 org) | org-scoped reads (`0006`–`0008`); procurement/paying authority |
| `organization_memberships` | procurement-org manager, paying-org manager, cross-org manager | contract-write authority (`0004`); related-org read; paying≠write |
| `apps` | A: 2–3 (with `responsible_org_id`/`paying_org_id`/`procurement_owner_org_id`); B: 1 | `/apps` list + `/apps/[id]` detail + account-intelligence |
| `contracts` | A: 2–3 (with `procurement_org_id`/`paying_org_id`); B: 1 | `/contracts` list + detail + create/edit; write authority |
| `app_contracts` | A: 2–3 links (same-tenant) | app↔contract link panels (read) |
| `app_users` | A: a roster per app (several rows) | app-user roster + match-status column |
| `people` | A: a few | identity targets for matches (not directly surfaced; feeds matches) |
| `identity_accounts` | A: a few | identity accounts for matches |
| `app_user_identity_matches` | A: a few (matched/unmatched) | match-status slice on `/apps/[id]` |
| `files` | A: 1–2 metadata rows (no Storage objects) | `files` RLS (`0013`) + the `0015` grant + Storage path tie-in (not app-surfaced) |
| `audit_logs` | (none seeded) | written **automatically** by the `0010` contract audit-on-write trigger during the create/edit validation |
| `invoices` / `license_rules` / `license_evaluations` | (none) | **not surfaced** — needed only for the not-built license/invoices/billing workflows (blockers, §6) |

---

## 3. Dataset area → doc 27 workflows → doc 17 §5 boxes

| Dataset area | doc 27 area | doc 17 §5 box(es) | Status of the surface |
|---|---|---|---|
| tenants/profiles/memberships | Track J (auth/roles), A (routes) | 5, 6, 8 | implemented (read) |
| organizations + org memberships | Track J, C; `0002`/`0004`/`0006`–`0008` | 8 | implemented (read) |
| apps + app_contracts | Track A (apps list/detail), B (link) | 1, 7, 9 | apps read **implemented**; link/unlink write **not built** |
| contracts | Track A/B/C (create/edit, fields) | 1, 7, 9 | read + create/edit **implemented (partial fields, [15])** |
| app_users + people/identity + matches | Track A (app users), identity matching | 7, 9 | roster + match-status **read implemented**; people directory **not built** |
| files | Track H (files/Storage) | 9, 13 | Storage boundary **done**; upload/UI/signed-URL **not built** |
| invoices/license/reporting/billing | Tracks E/F/M | 1 | **not built** (blockers) |
| audit_logs | Track L | 14 | `contracts` audit-on-write **implemented**; audit **UI not built** |

---

## 4. Implemented vs not-built/partial workflows

**Implemented (validate these — §5):** login/logout/session + tenant context; `/apps` list + `/apps/[id]`
detail (roster, match-status, account-summary); `/contracts` list + `/contracts/[id]` detail; contract
**create** (`/contracts/new`) + **edit** (`/contracts/[id]/edit`) — partial field parity ([15]); app↔contract
link **panels (read)**; org-scoped reads; RLS tenant isolation.

**Not built / partial (do NOT validate — these are BLOCKERS, §6):** file upload / signed-URL / preview /
file-audit; PDF/AI extraction; imports/connectors + credential vault; license rules/evaluations/ELU; invoices;
reporting/exports/dashboards; IDC billing; app-contract link/unlink **write** + cost allocation; UAR /
unmanaged / stale / people directory; admin/settings UI; audit-log UI; tenant switching.

---

## 5. Critical-workflow validation steps (IMPLEMENTED surfaces only)

Run **after** the dataset is loaded + synthetic Auth users exist (§8), in **staging**, by a human. The hosted
**Auth/tenant-context + RLS** layer is covered by the item-#1 verifier `scripts/verify-staging-auth-tenant-context.mjs`
([31](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)); the surface checks below are manual against the
deployed staging app. Record PASS/FAIL only — **no tokens/cookies/secrets.**

1. **Apps:** as the tenant-A editor, `/apps` lists **only** tenant A's apps (correct count); `/apps/[id]` shows
   the app-user roster, match-status, and account-summary for that app.
2. **Contracts (read):** `/contracts` lists only tenant A's contracts; `/contracts/[id]` shows the contract +
   its linked apps.
3. **Contract create:** `/contracts/new` as an authorized writer (tenant editor+ or the procurement-org
   manager) succeeds; **paying-org manager and tenant viewer are denied** (RLS `0004`); a `0010` audit row is
   written and the new contract appears in the list.
4. **Contract edit:** `/contracts/[id]/edit` updates persist; a `0010` audit row is written; unauthorized roles
   denied.
5. **Links:** the app↔contract panels show the seeded same-tenant links; no cross-tenant link is shown.
6. **Cross-tenant isolation (critical):** the tenant-B user sees **none** of tenant A's apps/contracts/links/
   app-users (and vice versa) — matches verifier R3/R4.
7. **Org-scoped reads:** the procurement-org manager sees the contracts/apps of their org per `0004`/`0006`–`0008`;
   the cross-org manager does not.

A green pass here + the item-#1 verifier green = evidence toward §5 boxes 7/9 (and 8). It does **not** tick any
box by itself, close RISK-001, or approve cutover.

---

## 6. Not-built flows are BLOCKERS, not validation failures

A workflow that **does not exist** cannot "fail validation" — it is a **blocker** (its [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)
row + [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) box stay open until it is **built**, then validated).
Record file-upload, AI, imports/connectors, license/invoices/reporting/billing, link/unlink write, UAR/people,
admin/settings, and audit-UI as **`not-built` blockers** in the evidence — **never** as "validation failed".

---

## 7. RLS / tenant-isolation expectations for the staging dataset

The dataset must **not weaken RLS**; it exists to *prove* RLS on hosted. Expectations (all enforced by
`0001`–`0015`, not by app code):
- A signed-in user reads **only** their tenant's rows; cross-tenant reads return 0 (verifier R3/R4).
- Org-scoped child reads follow `0006`–`0008` (org members see their org's apps/contracts; default-deny otherwise).
- Contract write requires `0004` authority (tenant editor+ **or** procurement-org manager); **`paying_org` never
  grants write**; no UPDATE/DELETE/`FOR ALL` beyond what the migrations allow.
- `files` reads follow `0013` (tenant member); the **`0015` `authenticated` grant must be present on staging**
  (verifier R5) so a tenant member's `files` SELECT does not hit a base-privilege error.
- Synthetic users have **full tenant isolation** — no cross-tenant `organization_membership` ([31 §4](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)).

---

## 8. Setup + cleanup (human, later — NOT executed here)

**Preconditions (each run):** `supabase link --project-ref ycdpzduxugdsffjqyoai`; confirm
`cat supabase/.temp/project-ref` = `ycdpzduxugdsffjqyoai` (**never** the production ref `dzbfxulvxchdemcettrx`);
use synthetic data only; record **no** secrets.

**Setup (staging only, human):**
1. Create the synthetic Auth users (Auth admin / dashboard) per [31 §4](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)
   — separate elevated step; capture creds in **local env only**.
2. Apply the §9 dataset template in the **staging SQL editor** (or a psql session deliberately pointed at
   staging after the ref check), using the created users' UUIDs for `profiles`/memberships.

**Cleanup (staging only, human, after validation):** mirror the [29 §6](./29_PRODUCTION_STORAGE_APPLY_EVIDENCE.md)
discipline — remove the synthetic business rows + Auth users; `audit_logs` is **append-only**
(`reject_audit_mutation()`, `0002`), so audit rows + their anchor tenants are retained intentionally.

---

## 9. Dataset SQL template (review + apply in STAGING only — illustrative, synthetic, no secrets)

> **Not a committed runnable script.** Review, adapt the UUIDs to your created Auth users, and run **only** in
> the staging SQL editor after the §8 project-ref check. Synthetic IDs reuse the [31 §4](./31_HOSTED_STAGING_AUTH_TENANT_CONTEXT_VERIFICATION.md)
> shape (tenant A `aaaa1111-…`, tenant B `bbbb2222-…`). Insert `profiles` with the **created** Auth user UUIDs.
> No `auth.users` inserts here (those are created via the Auth admin step, §8). Extend the row counts per §2.

```sql
-- STAGING ONLY · synthetic · no secrets · run after confirming project ref = ycdpzduxugdsffjqyoai
-- tenants
insert into public.tenants (id, name, slug) values
  ('aaaa1111-1111-1111-1111-111111111111','Acme (synthetic)','acme-synthetic'),
  ('bbbb2222-2222-2222-2222-222222222222','Globex (synthetic)','globex-synthetic');
-- organizations (procurement / paying / BU in tenant A; one in B)
insert into public.organizations (id, tenant_id, name) values
  ('0a000000-0000-0000-0000-0000000000a1','aaaa1111-1111-1111-1111-111111111111','Acme Procurement Org'),
  ('0a000000-0000-0000-0000-0000000000a3','aaaa1111-1111-1111-1111-111111111111','Acme Paying Org'),
  ('0bbb0000-0000-0000-0000-0000000000b1','bbbb2222-2222-2222-2222-222222222222','Globex Org');
-- profiles + memberships: use the UUIDs of the Auth users created in §8 (tenant editor/viewer/owner, org mgrs).
-- apps / contracts / app_contracts / app_users / people / identity_accounts / app_user_identity_matches /
-- files (metadata only): seed several per §2, all under the tenant-A / tenant-B ids above, with the org FKs
-- set so org-scoped reads + contract-write authority are exercised. (Full rows omitted — adapt to §2 counts.)
```

---

## 10. Risk posture

**RISK-001 remains OPEN** — this prepares evidence toward §5 boxes 7/9/8, not its closure. **Cutover remains
BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but not sufficient for
cutover.** This runbook loads no data, runs no validation, mutates no staging/production, and records no
secrets; RLS is unchanged. RISK-002/007/013/015/016 remain open. OMC/Flywheel is a paying production
**replacement, not a pilot**.
