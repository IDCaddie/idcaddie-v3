# 75 — Full-Product Okta Demo — Phase 0 Discovery & Readiness Matrix

**Status:** DISCOVERY ONLY. No code, SQL, migrations, or implementation in this pass.
**Purpose:** establish what V3 can truthfully demonstrate today, before any demo work begins.

---

## 1. Repository state

| | |
|---|---|
| Repository | `idcaddie-v3` |
| Branch | `main` |
| Exact HEAD | `3b748868e3a600775cf7eb2dcd04f289f86eccdf` — *"fix(access): /access load failure — counts RPC arg mismatch (Phase 15 Part 2, PR I) (#350)"* |
| Working tree | clean except two untracked docs (`docs/74`, `docs/reviews/PHASE_16A_…`) |
| Migration maximum | **0061** (`0061_canonical_directory_product_read_rpcs.sql`), 61 total |
| Test files | 160 (`*.test.ts*` + `*_test.sql`) |
| Test runner | `vitest run` (`npm test`); RLS suite via Docker (`test-rls.sh`); no standalone `typecheck` script — `next build` performs it |
| CI state | not run in this session; must be captured at exact head before any acceptance claim |

**Governance status, from authoritative sources (not prior prompts):** RISK-007 is **CLOSED at its staging-defined criteria**
(`docs/04`, closure register `docs/65` R-018/#291). Phase C is **UNBLOCKED as a governance state only** (`docs/66` R-019/#292 —
"does not run C-2c, does not run connector live data-sync, does not touch production, and does not authorize any production
action"). Okta and Entra remain `certificationOnly`. `docs/55` still reads OPEN/BLOCKED and self-declares parts historical; where it
conflicts, `docs/04`/`65`/`66` govern.

---

## 2. Complete authenticated route inventory

13 linkable routes (`nav-items.ts:12` `IMPLEMENTED_ROUTES`) + sub-routes. Nav is display-only; authorization is server-side.

| Route | Purpose | Authorization | Data source | Demo chapter |
|---|---|---|---|---|
| `/` | Home | tenant member | `dashboard.ts` | 1 |
| `/dashboards` | Read-only summary | tenant member | `dashboard-summary` + `dashboard-overview` | 1 |
| `/needs-attention` | Cleanup queue | tenant member | `needs-attention.ts` over apps/contracts/connectors DALs | 2 |
| `/apps` | Operational app inventory | `is_tenant_member` (`0001:292`) + org members (`0002:153`) | `listAppsWithCountsForCurrentUser` | 3 |
| `/apps/[id]` | Operational app detail | as above | `getAppDetailForCurrentUser` | 3 |
| `/catalog` | Canonical vendor/product graph | tenant member | `catalog.ts` (0024 graph) | 3 (optional) |
| `/contracts` · `/contracts/[id]` · `/new` · `/edit` | Contract inventory + detail + **write** | read: member; write: owner/admin/editor | `contracts.ts`, `contract-write.ts` | 4 |
| `/files` | Read-only file list | tenant member | `files.ts` | 5 |
| `/connectors` | **Preview marketplace** | tenant member | **static catalog** (`customer-connectors/catalog`) | 6 — see §4 |
| `/connectors/[provider]` · `/connect` · `/status` | Preview connection mgmt | tenant member | **demo-state-driven client island** | 6 — see §4 |
| `/connectors/review` | Operator sync-review | **owner/admin/editor** | real counts + timestamps, RLS status-only writes | 6 |
| `/access` | Access governance overview | **owner/admin** (`accessGate`) | 0061 RPCs → Phase 13/14 | 7 |
| `/access/findings` | Findings list + filters | owner/admin | as above | 10 |
| `/access/identities/[id]` | Identity access detail | owner/admin | `loadIdentityAccessDetail` | 8 |
| `/access/applications/[id]` | Application access detail | owner/admin | `loadApplicationAccessDetail` | 9, 11 |
| `/access/*/export` (×3) | Bounded CSV | owner/admin | same loaders | 4/7 |
| `/people` | People / match status | tenant member | `people.ts` | 8 (context) |
| `/reports` | Summary counts | tenant member | `reports.ts` | 12 |
| `/audit` | Recent audit entries | `is_tenant_member` | `audit.ts` | 12 |
| `/admin` | Read-only account context | tenant member | `resolveTenantContext` | 13 |
| `/internal/slack-sync` | Internal ops | internal | — | **exclude** |

**Declared not-built** (from each page's own `NOT_BUILT` list — these are honest and must stay): custom dashboard builder ·
**connector-driven spend / license dashboards** · AI dashboard insights · dashboard export · scheduled delivery · report
generation/export/scheduling · standalone file upload/download/export · identity-match resolution · admin writes (invitations,
roles, SSO, SCIM, vault, billing, API keys, retention) · AI/Analysis.

---

## 3. Feature inventory — what is genuinely implemented

**Real and demo-grade:**

- **Spend** — `aggregateSpend` (`dashboard-overview.ts:23`) produces per-currency totals with a `contractsWithCost` count, coerces
  numerics and guards non-finite values. Correctly does **not** sum across currencies. `formatMoney` (`:44`).
- **Renewals** — `bucketRenewals` (`:77`) → `due30`, `due90`, `missing`, `topUpcoming` (5 soonest), each item carrying `daysUntil`,
  `noticeDeadline`, and a `basis` flag recording whether the date came from `renewal_date` or fell back to `end_date`.
- **Operational apps** — `AppDetail` (`apps.ts:31`): name, vendor, category, status, non-secret instance markers, org references
  (**IDs only** — name enrichment deliberately deferred), **ownership as booleans only** (raw owner FKs never leave the DAL),
  timestamps. `AppInventoryRow` adds RLS-scoped `linkedContractCount`, `appUserCount`, `hasOwner`.
- **Contracts** — inventory, detail, create/edit (owner/admin/editor), file linkage, audit-on-write by DB trigger (`0010`).
- **Access governance** — the full accepted Phase 15 surface: effective access with DIRECT/GROUP/BOTH, governance findings scoped
  `subjectId === appId || relatedIds.includes(appId)` (`access-loaders.ts:166`), freshness, bounded-completeness, filters,
  pagination, drill-down, three bounded CSV exports with formula-injection neutralisation.
- **Audit** — `audit_logs` append-only (`reject_audit_mutation`, `0002:252-265`), audit-on-write trigger precedent (`0010`).

**Real but constrained:**

- **`/audit` DTO withholds the actor** — exposes `action / resource_type / created_at` + `actorRecorded: boolean` only
  (`audit.ts`). Chapter 12 must not claim actor attribution from this route.
- **`audit_logs` readership is `is_tenant_member`** (`0001:323`) — every tenant member of every role reads every row.
- **`has_tenant_role` returns `boolean`** (`0001:238`) — it tells you *whether*, never *which* role.

---

## 4. Demo-readiness matrix

| Chapter | Surface | Classification | Reason |
|---|---|---|---|
| 1 Executive overview | `/`, `/dashboards` | **WORKING BUT NEEDS FIXTURE DATA** | Metrics are real (counts, spend by currency, renewal buckets); the fixture must make them non-trivial. **Connector-driven spend is NOT built** — do not show it |
| 2 Needs attention | `/needs-attention` | **WORKING BUT NEEDS FIXTURE DATA** | Sections carry `ok/empty/error/deferred` states; needs seeded attention cases |
| 3 Application inventory | `/apps`, `/apps/[id]` | **WORKING BUT NEEDS FIXTURE DATA** | Search/filter/counts/ownership booleans all real |
| 4 Contracts, spend, renewals | `/contracts` | **DEMO READY** *(with fixture)* | Spend and renewals are genuinely computed. Do **not** claim savings, license waste, or forecasts |
| 5 Files | `/files` | **PARTIAL** | Read-only list + linkage only. Upload happens on a contract; no standalone download/export; **no content extraction**. Demo metadata and linkage honestly |
| 6 Connectors & freshness | `/connectors`, `/connectors/[provider]/status` | **NOT SAFE TO DEMONSTRATE AS A TRUST SURFACE** | Both are **preview/simulated**: static catalog, "connecting runs a simulated flow, nothing syncs, no credentials stored, no provider activated"; the status page is an explicitly demo-state-driven client island. **They cannot show real sync time, freshness, or discovered counts** |
| 6 (substitute) | `/connectors/review` + freshness badges in `/access` | **WORKING** | `/connectors/review` has real counts and timestamps (owner/admin/editor). `/access` carries real `sync_status` / `stale_since` |
| 7 Access governance overview | `/access` | **WORKING BUT NEEDS FIXTURE DATA** | Blocked today by fixture (§5) |
| 8 Identity investigation | `/access/identities/[id]` | **WORKING BUT NEEDS FIXTURE DATA** | Requires GROUP/BOTH data that does not exist |
| 9 Application access | `/access/applications/[id]` | **WORKING BUT NEEDS FIXTURE DATA** | As above |
| 10 Governance findings | `/access/findings` | **WORKING BUT NEEDS FIXTURE DATA** | Findings are **computed per request, not persisted** — must be described accurately |
| 11 Access Review decision | `/access/applications/[id]` | **NOT IMPLEMENTED** | The only material new build. Design: `docs/74` |
| 12 Audit & accountability | `/audit` + review history | **PARTIAL** | `/audit` withholds the actor; attribution must come from the review history, with the distinction explained |
| 13 Role & tenant security | tests + live | **WORKING** | Demonstrable via existing RLS suite + live denials |
| 14 Close | `/` | **WORKING** | — |

---

## 5. Fixture inventory — the critical path

**Existing local fixture** — `supabase/fixtures/local_demo.sql` (93 lines, 9 inserts), seeded by `scripts/seed-local-demo.sh` into
a **throwaway local Postgres**, applied twice to prove idempotency, with no hosted code path. Covers **operational world only**:
`tenants, profiles, tenant_memberships, organizations, organization_memberships, apps, contracts, app_contracts`.

**It covers no directory data at all** — no `identity_accounts`, `directory_groups`, `directory_applications`, memberships, or
assignments. So Chapters 7–11 have no local fixture.

**Staging canonical tenant** `aaaa1111-1111-1111-1111-111111111111` (per `docs/73`):

| Fact | Consequence |
|---|---|
| identities 1 · groups 2 · applications 2 · memberships 1 · direct assignments 1 · **group assignments 0** | **GROUP and BOTH classifications are impossible.** Chapters 7–9 explicitly require all three |
| Tenant has **only `editor` + `viewer`** members — **no owner, no admin** | **Nobody can open `/access` at all** — it is owner/admin-gated. The entire access half of the demo is unreachable in this tenant today |
| `docs/73` treats fixture drift as a stop condition | The demo must **not** mutate this tenant; it needs its own |

**These two facts are the single largest blocker to the demo and must be PR B's first objective.**

Other staging fixtures: `staging_apps_people_verification.sql`, `staging_sync_review_reject_verification.sql`,
`staging_sync_review_stale_verification.sql` — verification fixtures, not demo data; do not repurpose.

---

## 6. Proposed narrative (corrected for truth)

The 14-chapter arc holds, with three corrections:

1. **Chapter 6 is re-pointed.** Connector *freshness* is demonstrated from `/connectors/review` and the `/access` freshness badges,
   **not** from `/connectors`, which is a simulated marketplace. `/connectors` may still be shown — as a marketplace preview,
   explicitly labelled.
2. **Chapter 4 drops any savings/waste/forecast claim.** Spend-by-currency and renewal buckets are real; nothing else is.
3. **Chapter 12 splits attribution.** The technical audit event proves *an event occurred*; the immutable review history proves
   *who decided*. `/audit` cannot show the actor and the script must say so rather than implying otherwise.

**The two application worlds stay separate throughout**, narrated as *"Operational application inventory"* (Chapters 3–5) and
*"Provider directory access evidence"* (Chapters 7–11). `apps.canonical_app_id` (`0024:97`) and
`directory_applications.catalog_product_id` (`0057:43`) both target `app_products` and **neither is populated**; `canonical_app_id`
appears in no application code. **No join is to be manufactured.**

---

## 7. PR plan

| PR | Scope | Depends on |
|---|---|---|
| **A** | This document + demo narrative + fixture plan. Docs only | — |
| **B1** | **Demo tenant + operational fixture** — Northstar Labs: an owner/admin synthetic member, 8–15 apps, vendors/categories, owned + unowned, contracts with varied currencies and renewal dates, files, ≥2 attention cases. Extends `local_demo.sql` conventions; idempotent; isolated tenant | A |
| **B2** | **Directory fixture** — 8–15 identities, groups, directory applications, direct assignments, **group assignments (currently 0)**, ≥1 BOTH relationship, ≥1 stale node, findings that follow from the topology. This is the blocker-clearing PR | B1 |
| **C** | Access Review persistence + security (migration 0062, owner/admin RLS, zero DML to request roles, append-only, audit-on-write, reviewer snapshot) | B2 |
| **D** | Access Review trusted evidence layer — snapshot builder over `loadApplicationAccessDetail`, `includeStale` pinned, bounded blocks submission. **Gate: a test asserting every snapshot field exists on `ApplicationAccessDetailData`** | C |
| **E** | Access Review UX — card, evidence preview, Approved/Flagged, bounded note, history, accessibility | D |
| **F** | Whole-product polish — navigation gaps, count reconciliation, deterministic ordering, loading/empty/error states, copy consistency | B2 |
| **G** | Demo verifier + presenter script (full 15–25 min and 5 min), read-only smoke separate from the explicitly-authorized mutating check | all |

---

## 8. Genuine blockers

| # | Blocker | Impact | Resolution |
|---|---|---|---|
| **BL-1** | Canonical staging tenant has **no owner/admin** | `/access` unreachable → Chapters 7–11 impossible | New demo tenant with a synthetic owner (PR B1) |
| **BL-2** | **Zero group assignments** anywhere | GROUP and BOTH cannot be shown; Chapters 7–9 under-deliver | Directory fixture (PR B2) |
| **BL-3** | No directory fixture exists locally | Chapters 7–11 untestable outside staging | PR B2 |
| **BL-4** | Access Review not implemented | Chapter 11 absent | PRs C–E |
| **BL-5** | `/connectors` is simulated | Chapter 6 as written is untruthful | Re-point to `/connectors/review` + `/access` freshness |
| **BL-6** | `/audit` withholds the actor | Chapter 12 cannot show "who" from that route | Split attribution narrative |
| **BL-7** | No index route for directory applications/identities | Chapter 9 needs a UUID unless entered via findings/overview | Enter via `/access` → findings → application; or add an index in PR F |

---

## 9. Demoable as-is · needs fixture · needs code · must be excluded

**As-is (no work):** `/admin`, `/reports`, role/tenant denials (Chapter 13), the truthfulness disclaimers throughout `/access`.

**Needs fixture only:** `/`, `/dashboards`, `/needs-attention`, `/apps`, `/apps/[id]`, `/contracts`, `/files`, `/access` and all
four access sub-routes, `/access/*/export`, `/connectors/review`.

**Needs code:** Access Review (Chapters 11–12) — PRs C–E. Optionally a directory index route (BL-7) in PR F.

**Must be excluded or relabelled:**

| Item | Why |
|---|---|
| `/connectors` and `/connectors/[provider]/status` as a *trust* surface | Simulated; no sync, no credentials, no provider activation |
| Connector-driven spend / license dashboards | Declared not built |
| Savings, cost avoidance, licence waste, renewal forecast, duplicate-contract claims | Not computed; forbidden by `docs/71`/`docs/72` |
| File content extraction / document analysis | Not implemented — show metadata and linkage only |
| Actor identity on `/audit` | DTO withholds it by design |
| Any unified application record across the two worlds | Bridge unpopulated |
| `/internal/slack-sync` | Internal ops surface |
| Hosted live connector sync | Requires a separate explicit GO; not needed for the demo |

---

## 10. Safety confirmations for this pass

Discovery was **read-only**: `git` status/log, file reads, and greps. No database was contacted, no hosted command run, no
secret read, no `aws secretsmanager` invocation, no connector touched, no production or staging resource modified, and no Okta
tenant contacted. Migration maximum is unchanged at 0061.

---

## 11. PR B2 — DELIVERED (local only)

The demo tenant and directory fixture are built and verified locally: `supabase/fixtures/northstar_demo.sql`,
`scripts/seed-northstar-demo.sh`, `src/lib/data/northstar-fixture.test.ts`, documented in
[76_NORTHSTAR_DEMO_FIXTURE.md](./76_NORTHSTAR_DEMO_FIXTURE.md).

**Blockers cleared:** BL-1 (no owner/admin) — four roles seeded · BL-2 (zero group assignments) — 5 group assignments with DIRECT,
GROUP and BOTH all engine-verified · BL-3 (no local directory fixture) — now exists.

**Still open:** BL-4 (Access Review not implemented — PRs C–E) · BL-5 (`/connectors` simulated — narrative re-pointed) ·
BL-6 (`/audit` withholds actor — narrative split) · BL-7 (no directory application index — enter via findings, or add in PR F).

**Not applied to hosted staging.** See `docs/76` §6 for the runbook and the explicit GO it requires.

## 12. Recommended next step

**PR B2 was the critical path** — without group assignments and an owner/admin member, more than half the demo cannot be shown at
all. It should be built and verified before any Access Review code, because Chapters 7–11 are the story that Chapter 11 concludes.
