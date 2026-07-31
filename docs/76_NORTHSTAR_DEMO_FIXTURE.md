# 76 — Northstar Labs Demo Fixture (PR B2)

**What this is.** One deterministic, isolated synthetic tenant that supports the full IDCaddie v3 demo story — operational SaaS
management (Chapters 1–5) and provider directory access governance (Chapters 7–10), with the Access Review finale (Chapter 11)
to be added by PRs C–E.

**Status:** built and verified **locally only**. **Nothing has been applied to hosted staging** — that requires an explicit GO
(§6).

| | |
|---|---|
| Fixture | `supabase/fixtures/northstar_demo.sql` — **not a migration**; migration maximum stays **0061** |
| Seed script | `scripts/seed-northstar-demo.sh` — throwaway local Postgres, no hosted code path |
| Engine test | `src/lib/data/northstar-fixture.test.ts` — 10 tests, all passing |
| Tenant | `e0000000-0000-0000-0000-00000000a000` — "Northstar Labs" (`northstar-labs`) |

---

## 1. Isolation guarantee

Every id is under the `e0000000-` prefix and every row is bound to the Northstar tenant.

**The Phase 15 verifier tenant `aaaa1111-1111-1111-1111-111111111111` is never referenced, read, or written.** `docs/73` treats
drift in that fixture as a stop condition, so it is left completely alone. The older `d0000000-` local demo tenant is likewise
untouched.

Three independent proofs:

1. **Seed-script assertion** — raises `ISOLATION BREACH` if the verifier tenant exists in the database at all.
2. **Seed-script report** — prints `verifier-tenant rows : 0` and `non-Northstar tenants : 0` on every run.
3. **Engine test** — asserts every graph id starts with `e0000000-` and none carries the verifier prefix.

---

## 2. Users and roles

| UUID | Email | Role |
|---|---|---|
| `e0000000-…-000000000001` | `northstar-owner@idcaddie-staging.local` | **owner** |
| `…0002` | `northstar-admin@idcaddie-staging.local` | **admin** |
| `…0003` | `northstar-editor@idcaddie-staging.local` | editor |
| `…0004` | `northstar-viewer@idcaddie-staging.local` | viewer |

All four are `status='active'`. `profiles` rows are inserted **before** `tenant_memberships` to satisfy the
`user_id → profiles(id)` FK. **No passwords appear in the repository.**

Owner and admin can reach `/access`; editor and viewer are denied by `accessGate` — which is what makes Chapter 13 demonstrable
with real principals rather than a mocked role switcher.

---

## 3. Data map — which records drive which chapter

### Operational world (Chapters 1–5)

| Records | Drives |
|---|---|
| **12 apps** `…e001–e012` — Salesforce, Slack, GitHub, Zoom, Notion, Figma, Jira, Confluence, Asana, Dropbox, Miro, Okta | `/apps` inventory, search, filters, status badges |
| 4 apps with **no `responsible_org_id`** (Notion, Figma, Asana, Dropbox) | Ownership-gap attention cases; `hasOwner: false` |
| 2 apps with `status='inactive'` (Asana, Dropbox) | Status variety in filters |
| **8 contracts** `…f001–f008` | `/contracts`, spend, renewals |
| `f001` renewal **+15d** | `RenewalBuckets.due30` |
| `f002` renewal **+60d** | `RenewalBuckets.due90` |
| `f003` **no renewal_date, no end_date** | `RenewalBuckets.missing` |
| `f004` **end_date only** | Proves `RenewalItem.basis === "end"` fallback |
| `f007` **GBP** (all others USD) | Proves `aggregateSpend` splits per currency and never cross-sums |
| `f008` **null `total_cost`** | Excluded from `contractsWithCost` |
| billing_frequency: annual ×5, monthly ×3 | Billing-interval variety |
| **9 app↔contract links** | Contract linkage on app detail; `linkedContractCount` |
| **4 files** `…7001–7004` | `/files` list, metadata, contract linkage |

**Files carry `processing_status='pending'` and `extraction_result_json` NULL** — no content extraction is performed or claimed
(`docs/75` §4). `storage_path` is a synthetic deterministic path; no object exists behind it and none is needed for the read-only
list.

### Directory world (Chapters 7–10)

One connector `…d001` (`provider='okta'`, `status='active'`) — synthetic, **no credentials, no sync, no real Okta contact**.

| Records | Drives |
|---|---|
| **12 identities** `…1001–1012` | `/access` identity counts, identity detail |
| **5 groups** `…2001–2005` — Sales, Engineering, Finance, Contractors, Administrators | Group counts, inherited paths |
| **6 directory applications** `…3001–3006` | `/access/applications/[id]` |
| **10 group memberships**, **6 direct assignments**, **5 group assignments** | Effective-access resolution |

### The four demo-critical access cases

| Case | Records | Engine result |
|---|---|---|
| **DIRECT** | Avery Chen `…1001` → Salesforce `…3001`, direct only, **no group path** | `classification = DIRECT` |
| **GROUP** | Jordan Patel `…1002` ∈ Sales `…2001` → Salesforce, **no direct assignment** | `classification = GROUP` |
| **BOTH** | Morgan Lee `…1003` → GitHub `…3002` directly **and** via Engineering `…2002` | `classification = BOTH` |
| **Stale endpoint** | Sam Okoro `…1012` is `sync_status='stale'` (`stale_since` −45d) but holds a **current** Salesforce assignment; Zoom `…3005` is a stale application node with a current assignment | freshness badges + finding |

### Governance findings — engine-derived, never seeded

The fixture creates **graph conditions**; `evaluateGovernance` derives the findings. Verified by test:

| Rule | Condition created |
|---|---|
| `redundant_direct_access` | the BOTH case (Morgan → GitHub two ways) |
| `direct_assignment_with_stale_endpoint` | current assignment → stale identity node (Sam Okoro) |
| `duplicate_inherited_access_paths` | Jira `…3004` reachable via **both** Finance and Contractors, and Alex Kim `…1008` is in both |
| `group_without_application_reach` | Administrators `…2005` grants no application |
| `application_without_effective_identities` | Dropbox `…3006` has no identities |
| `identity_without_effective_access` | Dana Wu `…1011` has no group and no assignment |

**Honest limitation — `high` severity is not achievable.** Per `docs/71` the only `high`-severity rules are structural graph
diagnostics (`assignment_missing_identity`, `cross_scope_edge_ignored`, …), and the composite four-column FKs on the edge tables
make those states **impossible to insert**. The fixture therefore produces `info` / `low` / `medium` only, and the test asserts at
least one **medium** so the demo is not all info-level noise. No high-severity finding is faked.

TypeScript additionally proves `GovernanceSeverity` has no `critical` member — the "never critical" claim in `docs/71` is
compile-time guaranteed, not merely asserted.

---

## 4. No cross-world join

Salesforce, Slack, GitHub, Zoom, Jira and Dropbox appear in **both** worlds as familiar labels. **They are not joined and must
never be presented as joined.** `apps.canonical_app_id` (`0024:97`) and `directory_applications.catalog_product_id` (`0057:43`)
both target `app_products` and **neither is populated** — `0024:13-16` implements no resolver and `0057:10,20` keeps the match
`unmatched`. The fixture deliberately does **not** populate either.

Demo language: **"operational application inventory"** (Chapters 3–5) vs **"provider directory access evidence"** (Chapters 7–10).

---

## 5. Running it locally

```bash
bash scripts/seed-northstar-demo.sh          # seed, assert, tear down
bash scripts/seed-northstar-demo.sh --keep   # leave the DB up on 127.0.0.1:55433
npx vitest run src/lib/data/northstar-fixture.test.ts
```

The script refuses any argument that looks like a hosted target (`--linked`, a URL, `*.supabase.*`) and always creates its own
throwaway container. The fixture is applied **twice** to prove idempotency — verified: counts do not double.

**Verified local run:** 61 migrations applied · fixture applied twice · summary `4 memberships / 12 apps / 8 contracts / 4 files /
12 identities / 5 groups / 6 directory applications / 10 memberships / 6 user assignments / 5 group assignments` · all acceptance
assertions passed · `verifier-tenant rows : 0`.

---

## 6. Hosted staging application — NOT DONE, requires explicit GO

**Nothing in this PR has been applied to staging.** Applying it would require all of the following, and I have deliberately not
done any of it:

1. **Four Auth users must be created manually.** Hosted GoTrue owns `auth.users`; the fixture's `insert into auth.users` works only
   against the local shim. An operator must create the four `northstar-*@idcaddie-staging.local` users in the staging Auth
   dashboard and record their assigned UUIDs.
2. **A staging variant of the fixture** — identical, minus the `auth.users` insert, with the four `profiles.id` values replaced by
   the UUIDs GoTrue assigned in step 1.
3. **Applied in the staging SQL editor** after confirming project ref `ycdpzduxugdsffjqyoai`, never via `supabase db push`.

**Reversibility:** deleting the tenant row `e0000000-…a000` removes everything — every table in the fixture carries
`tenant_id → tenants(id) on delete cascade`.

**Phase 15 protection during application:** the fixture writes only `e0000000-` prefixed ids and touches no shared row, so the
verifier tenant and its fixture counts are unaffected. Re-running
`node scripts/verify-staging-access-surface.mjs --preflight` after application should show no change.

**Not required and not requested:** no connector sync, no ECS task, no AWS call, no secret read, no Okta contact, no
connector-runner change, no production access.

---

## 7. Known limitations

| Limitation | Why |
|---|---|
| No `high`-severity finding | Structurally impossible (§3) |
| Access Review card absent | PRs C–E |
| No directory application **index** route | Enter via `/access` → findings → application detail (`docs/75` BL-7) |
| `/connectors` shows a simulated marketplace | Preview-only by design; use `/connectors/review` and `/access` freshness badges instead (`docs/75` §4) |
| Contract dates are relative to seed time | Deliberate — keeps renewal buckets stable on any run day. Row **ids** are fully deterministic |
| No cross-world join | §4 |
