# 74 — Application Governance Attestations (Phase 16A) — Evidence-Driven Product Design

**Status:** PRODUCT DISCOVERY + DESIGN. No code, SQL, migrations, tables, React, TypeScript, PR, or commits.

**Method — and why this document is different.** Four prior Phase 16A specifications failed review because they began with a
desired product and assumed platform capabilities to support it. Every one asserted at least one field that does not exist
(`status_category` on a DTO that omits it; a role from a function returning `boolean`; a business-justification column with zero
occurrences in the repository). **This document reverses the order.** Step 1 inventories what V3 actually returns, traced to file
and line. Step 2 classifies each item. Only then does a product get designed, and it may use nothing outside that inventory.

**Rule applied throughout:** if a field is not traceable to a concrete return type in the repository, it does not appear in the
design. Not as "optional", not as "where available".

---

# STEP 1 — INVENTORY

## 1.1 The structural fact that shapes everything

**V3 has two application worlds, and they do not join today.**

| | **Directory application** | **Operational application** |
|---|---|---|
| Table | `directory_applications` | `public.apps` |
| Surface | `/access/applications/[id]` | `/apps` (index) + `/apps/[id]` (detail) |
| Read path | `loadApplicationAccessDetail` → `getApplicationAccessSubgraph` → 0061 RPC | `getAppDetailForCurrentUser` → RLS-backed table read |
| Read authorization | **owner/admin only** (`accessGate`, `access-repository.ts:31`; in-body `has_tenant_role` in every 0061 RPC) | **any tenant member** (`"members read apps"` = `is_tenant_member`, `0001:292-293`) plus org members (`0002:153`) |
| Holds | access graph, effective access, governance findings, connector freshness | vendor, category, status, ownership booleans, org refs, contract/user counts, instance markers |
| Index route | **none** — only `page.tsx`, `findings/`, `identities/[id]/`, `applications/[id]/` | **yes** — `/apps/page.tsx` |

**The bridge exists in schema and is empty in practice.** `apps.canonical_app_id` (`0024:97`, FK to `app_products(id, tenant_id)`
`0024:103`, indexed `0024:144`) and `directory_applications.catalog_product_id` (`0057:43`) both point at `app_products`. But
`0024:13-16` states it implements no matching, no resolver, no merge job and writes no app-graph data; `0057:10,20` keeps
`catalog_product_id` NULL with `catalog_match_status = 'unmatched'`. `canonical_app_id` appears **nowhere in application code** —
only in generated `database.types.ts`.

**Consequence:** no v1 attestation may mix directory access evidence with operational business context. A design that does is
asserting a join that resolves to nothing. This single fact invalidated the previous four specs' central premise.

## 1.2 Directory application — `loadApplicationAccessDetail`

Return type `ApplicationAccessDetailData` (`access-loaders.ts:37-43`). **This is the complete set.** Nothing else is reachable
without a new read path.

| Field | Type | Source | Trusted | Tenant-scoped | Browser-safe | Complete | May be stale | Bounded | Already shown |
|---|---|---|---|---|---|---|---|---|---|
| `id` | uuid | 0061 subgraph | ✅ | ✅ | ✅ href param only | ✅ | n/a | n/a | as param |
| `displayName` | string | `label → name` fallback | ✅ | ✅ | ✅ safe label | ✅ | ✅ | n/a | ✅ `:44,63` |
| `providerLabel` | string | `provider` slug | ✅ | ✅ | ✅ bounded slug | ✅ | n/a | n/a | ✅ `:45,72` |
| `syncState` | `current \| stale` | `sync_status`, **collapsed 4→2** (`:46`) | ✅ | ✅ | ✅ | ⚠️ lossy | ✅ | n/a | ✅ `:64-65` |
| `staleSince` | ts \| null | `stale_since` (nullable) | ✅ | ✅ | ✅ | ⚠️ nullable | ✅ | n/a | — |
| `catalogMatchStatus` | string \| null | `catalog_match_status` | ✅ | ✅ | ✅ enum | ⚠️ always `unmatched` (`0057`) | n/a | n/a | ✅ `:67-68` |
| `bounded` | boolean | `total > SUBGRAPH_MAX_ROWS` (`:24,139`) | ✅ | ✅ | ✅ | ✅ | n/a | **is the bound** | ✅ `:41` |
| `effectiveIdentityCount` | int | `identities.length` (`:171`) | ✅ | ✅ | ✅ | ✅ when `!bounded` | ✅ | ✅ | ✅ `:77` |
| `directOnlyCount` / `groupOnlyCount` / `bothCount` | int | Phase 13 classification | ✅ | ✅ | ✅ | ✅ when `!bounded` | ✅ | ✅ | ✅ `:78-80` |
| `identities[]` | `{identityId, identityLabel, classification, classificationLabel, staleEvidence}` (`:37`) | Phase 13 | ✅ | ✅ | ✅ labels only | ✅ when `!bounded` | ✅ per-row | ✅ | ✅ `:98` |
| `assignedGroups[]` | `{groupLabel, staleEvidence}` (`:38`) | group assignments | ✅ | ✅ | ✅ label only | ✅ when `!bounded` | ✅ per-row | ✅ | ✅ `:84-90` |
| `findings[]` | `GovernanceFindingView[]`, scoped `subjectId === appId \|\| relatedIds.includes(appId)` (`:166`) | Phase 14 | ✅ | ✅ | ✅ | ✅ when `!bounded` | ✅ | ✅ | ✅ `:171` |

`GovernanceFindingView` (`access-view-models.ts:29-44`): `id, ruleId, subjectType, severity, severityLabel, severityTone,
confidence, confidenceLabel, title, summary, guidance, subject, evidenceRows, staleEvidence`. Severity is `info|low|medium|high`,
**never `critical`** (`docs/71`). `title/summary/guidance` come from `RULE_PROSE`, an exhaustive **static per-rule table with no
subject interpolation** (`governance-presenter.ts:12`). `subject` is a `SafeSubjectLink` carrying a **display label** — for an
identity subject, a person's name.

**Not on this DTO** (present on the 0061 row, discarded by the view model): `status_category`, `sign_on_category`, `connection_id`,
`is_active`, per-node raw `sync_status`. Reaching them requires a new read path.

**`bounded = true` returns empty lists and zero counts** (`:139-141`) — the counts are not merely capped, they are *absent*.

## 1.3 Operational application — `getAppDetailForCurrentUser` / `listAppsWithCountsForCurrentUser`

`AppDetail` (`apps.ts:31-49`):

| Field | Type | Trusted | Tenant-scoped | Browser-safe | Notes |
|---|---|---|---|---|---|
| `id`, `name`, `vendorName`, `category`, `status` | string / nullable | ✅ | ✅ RLS | ✅ | `status` is free text, not an enum |
| `externalInstanceId`, `instanceUrl` | string \| null | ✅ | ✅ | ✅ | **explicitly non-secret** (`apps.ts:37-40`); provider workspace id, not a token |
| `responsibleOrgId`, `payingOrgId`, `procurementOrgId` | uuid \| null | ✅ | ✅ | ⚠️ **IDs only** — org-name enrichment deliberately deferred (`apps.ts:26-28`) |
| `hasBusinessOwner`, `hasTechnicalOwner` | **boolean** | ✅ | ✅ | ✅ | raw owner FKs **never leave the DAL** (`apps.ts:43`) |
| `createdAt`, `updatedAt` | ts | ✅ | ✅ | ✅ | |

`AppInventoryRow` (`apps.ts:106-111`) adds `linkedContractCount`, `appUserCount`, `hasOwner` — **RLS-scoped counts** tallied in app
code (`apps.ts:124-126`), so they reflect what the *caller* may read. For an owner/admin, RLS exposes the whole tenant, so the
counts are complete **for our actor specifically**.

`listContractsLinkedToApp(appId)` (`links.ts:54`) returns `ContractSummary[]` via `app_contracts` under RLS.

`not_found` deliberately covers both "no such app" and "RLS hid it" (`apps.ts:56-58`) — non-enumerable, matching the Phase-15
posture.

**Deliberately excluded from `AppDetail`:** app users, invoices, files — "tenant-only / default-deny — RISK-002" (`apps.ts:30-31`).

## 1.4 Fields that do not exist anywhere

Verified by repository-wide search, not inference:

| Claimed by prior specs / old app | Reality |
|---|---|
| `business_justification` | **zero occurrences** in `supabase/migrations/` and `src/lib/` |
| `data_classification` | **zero occurrences** |
| Business/technical owner **name** | ownership is exposed as **booleans only** by design (`apps.ts:43`) |
| Privileged / high-risk identity count | no privilege or risk attribute in `docs/71`; `identity_broad_access` is a disabled-by-default threshold heuristic that explicitly does **not** claim over-provisioning |
| Cost / annual spend on an application | no join from either application world; `docs/71`/`docs/72` forbid cost, savings, licence and usage claims outright |
| Review cadence | no cadence column exists (`0044`/`0046` hits are connector scheduling) |
| Directory ↔ operational correlation | bridge columns exist, **neither is populated, no code reads or writes them** (§1.1) |
| `EvaluationCompleteness` 3-state type | declared at `access-view-models.ts:18-21` and **used nowhere** — dead code, not a capability |

## 1.5 Write and audit infrastructure that already exists

| Capability | Evidence |
|---|---|
| Server-action write pattern | `contracts/actions.ts` — `"use server"` thin wrapper → server-only DAL → RLS write |
| Audit-on-write by DB trigger | `0010` — `SECURITY DEFINER` trigger, `auth.uid()` returns **the caller** not the owner (verified by `org_rls_test.sql T31`, `0010:30-32`), curated non-sensitive allowlist into `after_json`, `before_json` deliberately NULL |
| Append-only audit enforcement | `reject_audit_mutation` + `audit_logs_no_mutation` BEFORE UPDATE OR DELETE (`0002:252-265`) |
| `audit_logs` readership | **`is_tenant_member` only** (`0001:323`) — every tenant member of every role reads every row |
| `/audit` DTO | exposes `action / resource_type / created_at` + `actorRecorded: boolean` — **withholds the actor** (`audit.ts`) |
| Role check | `has_tenant_role(tenant, text[]) returns **boolean**` (`0001:237-251`) — tells you *whether*, never *which* |
| Bounded CSV | `EXPORT_ROW_CAP = 10_000` (`access-export.ts:11`); `sanitizeCsvCell` formula/DDE neutralisation (`to-csv.ts`) |

---

# STEP 2 — CAPABILITY MATRIX

| Capability | Class | Justification |
|---|---|---|
| Effective identity count | **READY** | Computed by the accepted Phase-13 engine, tenant-scoped, already displayed |
| DIRECT / GROUP / BOTH breakdown | **READY** | Same; this is V3's differentiated signal and has no old-app equivalent |
| Assigned groups (labels) | **READY** | Labels only, already displayed |
| Governance findings for the app | **READY** | Deterministic scoping rule already in code (`:166`); severity/confidence are bounded enums |
| Finding counts by severity, highest severity | **READY** | Derived from `findings[].severity`, a four-value enum |
| Application display name, provider | **READY** | Safe-label fallback already in use |
| `bounded` completeness flag | **READY** | Explicit, and the only honest completeness signal available |
| Ownership booleans (`hasBusinessOwner` / `hasTechnicalOwner`) | **READY** | Truthful, non-PII, governance-relevant; already the DAL's deliberate shape |
| Linked contract count, app-user count | **READY** *(for owner/admin)* | RLS-scoped counts are complete when the caller is owner/admin (§1.3) |
| Vendor, category, status, instance markers | **READY** | Documented non-secret |
| `staleSince` | **PARTIAL** | Nullable — a non-current app may have no timestamp. Renders "since unknown", never a fabricated date |
| `syncState` | **PARTIAL** | Lossy: 4 states collapsed to 2 (`:46`). Must be labelled `current` / `not current`, never claimed as four-state |
| `catalogMatchStatus` | **PARTIAL** | Always `unmatched` this phase — carries no information yet, and the UI already says "Catalog match unavailable" |
| Org references | **PARTIAL** | IDs only, no names; useful as "assigned / not assigned", not as a display value |
| Identity labels inside findings (`SafeSubjectLink.label`) | **PARTIAL** | Real PII. Usable on screen; **must not be frozen** into a snapshot |
| Per-identity list | **PARTIAL** | Available and displayed, but unbounded in principle — freezing it would multiply PII at rest |
| `status_category`, `sign_on_category`, `connection_id`, `is_active` | **UNAVAILABLE** | On the 0061 row, discarded by the DTO. Would require a new read path |
| Four-state freshness fidelity | **UNAVAILABLE** | Collapsed before it reaches any caller |
| Business justification, data classification | **UNAVAILABLE** | Do not exist |
| Owner names | **UNAVAILABLE** | Booleans by design |
| Privileged / high-risk counts | **UNAVAILABLE** | No such attribute |
| Cost / spend | **UNAVAILABLE** | No join **and** forbidden by the truthfulness boundary |
| Directory ↔ operational correlation | **UNAVAILABLE** | Bridge unpopulated |
| Cadence | **UNAVAILABLE** | No storage; would be net-new |
| Reviewer's tenant role at write time | **PARTIAL** | Requires a `tenant_memberships.role` read; `has_tenant_role` returns boolean only |

---

# STEP 3 — REVIEW TYPES

The old three types are **not preserved**. Their names asserted verification V3 does not perform, and two of them were backed
almost entirely by UNAVAILABLE evidence. The inventory supports exactly two honest review types, each on the surface that holds its
evidence.

## 3.1 Access Review — *the v1 core*

- **Surface:** `/access/applications/[id]` (directory application)
- **Question:** *"Is the observed access to this application appropriate?"*
- **Evidence:** effective identity count · DIRECT-only / GROUP-only / BOTH counts · assigned-group count · governance finding count,
  counts by severity, highest severity · application freshness · `bounded` completeness
- **Frozen:** §4.1 below
- **Outcome:** Approved · Flagged for Review

This is the review V3 uniquely enables. The old app could only count rows in a client array; this states *how* access is held.

## 3.2 Application Governance Review — *same machinery, optional in v1*

- **Surface:** `/apps/[id]` (operational application)
- **Question:** *"Is this application's governance record complete and still appropriate?"*
- **Evidence:** ownership booleans · linked contract count · app-user count · vendor / category / status · connector-instance
  presence · org assignment booleans
- **Frozen:** §4.2 below
- **Outcome:** Approved · Flagged for Review

Deliberately **not** called "Business Justification": no justification text exists to review. It attests that the governance
*record* is complete (owners assigned, contracts linked), which is exactly what the evidence supports.

**No third review type.** A "Configuration & Security Review" would have to assert configuration inspection V3 does not perform.

---

# STEP 4 — PRODUCT

**Workflow:** Application → review evidence → Approve or Flag → history. No campaigns, reviewers, schedulers, notifications,
remediation, or provider mutation.

## 4.1 Frozen evidence — Access Review

```
snapshot_schema_version = 1
review_type             = access_review
frozen_at               (server clock)
include_stale           = false          -- PINNED; loadApplicationAccessDetail's default, recorded so counts are defined
application_row_id      uuid             -- directory_applications.id, no FK (§7)
application_label       text  ≤200
provider_slug           text  ≤64
application_freshness   enum { current, not_current }   -- 2-state, honestly named (§2)
stale_since             timestamptz?     -- may be null: "since unknown"
catalog_match_status    enum
effective_identity_count       int
direct_only_count / group_only_count / both_count   int
assigned_group_count           int
finding_count                  int
finding_counts_by_severity     { info, low, medium, high }   -- fixed four-key map
highest_finding_severity       enum { none, info, low, medium, high }
evidence_completeness          enum { complete }   -- only 'complete' can be frozen; see below
```

**Every field above is on `ApplicationAccessDetailData` or derived from it by counting.** No new read path.

**`bounded = true` blocks submission.** Because bounded returns empty lists *and zero counts* (`:139-141`), a snapshot taken from it
would record "0 identities, 0 findings" — a false clean bill of health. The form blocks with a stated reason and links to the live
view. `evidence_completeness` therefore only ever holds `complete`; it is stored so the record self-describes, not as a variable.

**No identity list, no group list, no finding prose is frozen.** Findings are counts by severity; the prose is static per-rule copy
(`governance-presenter.ts:12`) resolved at render time from `rule_id`. This keeps the snapshot free of the one PII channel the
finding view model carries (`SafeSubjectLink.label`).

## 4.2 Frozen evidence — Application Governance Review

```
snapshot_schema_version = 1
review_type             = application_governance_review
frozen_at               (server clock)
app_row_id              uuid             -- public.apps.id, no FK
app_name                text  ≤200
vendor_name             text? ≤200
category                text? ≤100
app_status              text  ≤64        -- free text upstream; stored verbatim, bounded
has_business_owner      boolean
has_technical_owner     boolean
linked_contract_count   int              -- RLS-scoped; complete for owner/admin (§1.3)
app_user_count          int              -- same
has_connector_instance  boolean          -- externalInstanceId != null
has_responsible_org / has_paying_org / has_procurement_org   boolean
```

Org references are stored as **booleans**, not IDs: the IDs carry no display meaning without the deferred name enrichment, and a
raw org uuid in an export is a hidden internal identifier.

## 4.3 Outcomes

**Approved** — the reviewer completed the review and, on the available evidence, identified nothing requiring follow-up.
**Flagged for Review** — the reviewer identified an issue, uncertainty, or missing evidence requiring investigation.

Neither changes access, removes anything, remediates, creates a ticket, mutates a provider, proves compliance, or guarantees the
application is secure or the evidence complete. The confirmation step says so in one sentence.

## 4.4 Note

Optional. Plain text, `MAX_NOTE_CHARS = 2000`, whitespace-normalised, control characters rejected, no HTML, no attachments. Stored
on the attestation record only; **never** copied into the audit event. Standing caution against entering secrets or sensitive
personal data.

## 4.5 Authorization

**Owner/admin only**, for both reading attestations and creating them. Editor, viewer, non-member, anonymous: denied, with a
not-found-equivalent.

Two surface-specific consequences the inventory forces:

- On `/access/applications/[id]` the page is *already* owner/admin-gated, so the attestation card inherits the correct audience.
- On `/apps/[id]` the page is readable by **any tenant member and org members** (`0001:292-293`, `0002:153`). The attestation card
  and its history must therefore be **hidden**, not merely disabled, for non-owner/admin, and the attestation tables carry their own
  `has_tenant_role(tenant_id, ARRAY['owner','admin'])` read policy — the host page's authorization is *not* inherited.

## 4.6 Reviewer identity and timestamp

Composed **server-side**, never from the client: `reviewer_user_id` (`auth.uid()`, nullable, **no foreign key**),
`reviewer_display_name`, `reviewer_email`, `reviewer_tenant_role`, `reviewed_at` (server clock).

`reviewer_tenant_role` requires reading `tenant_memberships.role` — `has_tenant_role` returns **boolean** (`0001:238`) and cannot
supply it. This is stated because three prior drafts got it wrong.

No FK: `profiles.id → auth.users(id) ON DELETE CASCADE` (`0001:16`) would destroy the attestation on offboarding;
`ON DELETE SET NULL` (the `audit_logs` choice, `0001:210`) would orphan it. Denormalising at write time keeps history attributable.

## 4.7 The browser submits only

`application_id` (or `app_id`), `review_type`, `outcome`, optional `note`, framework anti-forgery metadata. **No evidence, no
reviewer field, no role, no timestamp, no schema version.** Unexpected fields are rejected, not ignored.

## 4.8 Status without a scheduler

There is **no cadence storage in V3** and cadence is UNAVAILABLE (§2). v1 therefore does **not** ship Current/Overdue.

Each card shows, computed on read: **Never reviewed** (no record) or **Last reviewed `<date>` by `<reviewer>` — `<outcome>`**. A
"days since last review" figure is derivable and honest; a *due* date is not, because nothing defines the period.

Cadence is future work with a named cost (§9). This is a deliberate reduction from the old app, recorded in §5.

---

# STEP 5 — GAP ANALYSIS

| Feature | Old app | Prior Phase 16 spec | This design | Why |
|---|---|---|---|---|
| Application-level attestation | ✅ | ✅ | ✅ | Core value; fully supported |
| "User Access Review" name | ✅ | ✅ | ➜ **Access Review** | Renamed: no user *list* is frozen, and the evidence is access *paths*, not a roster |
| "Business Justification" | ✅ | ✅ | ❌ **removed** | `business_justification` and `data_classification` have **zero occurrences** in the repository. The type had no evidence |
| "Configuration & Security Review" | ✅ | ✅ | ❌ **removed** | V3 inspects no provider configuration. The name asserted verification that does not occur |
| Application governance record review | ❌ | ❌ | ✅ **added** | Ownership booleans + contract/user counts are READY and genuinely governance-relevant |
| Two outcomes, optional note | ✅ | ✅ | ✅ | Supported |
| Cadence + Current/Overdue | ✅ | ✅ | ❌ **deferred** | No cadence storage exists; the old app's day-count arithmetic (31/92/183/366) was also wrong. Net-new platform work |
| Client-composed reviewer identity | ✅ | fixed | fixed | Old app built `reviewedBy` in the browser |
| Client-authored snapshot | ✅ | fixed | fixed | Old app assembled `snapshot` from client state |
| Mutable "latest review" mirror | ✅ | fixed | fixed | Old app `update()`d a denormalised copy that could drift |
| Per-identity certification | ❌ | ✅ | ❌ **deferred** | Requires reviewer roles, assignment, delegation — none exist |
| Effective-access classification as evidence | ❌ | ✅ | ✅ | V3's genuine differentiator |
| Frozen finding prose | ❌ | ✅ then removed | ❌ | Static per-rule copy; storing it adds an unredactable PII risk for no gain |
| Frozen identity list | ✅ (`userCount` only) | ❌ | ❌ | Unbounded PII at rest |
| Provider remediation | ❌ | ❌ | ❌ | Out of scope, permanently in v1 |

---

# STEP 6 — DELIVERABLES

## 6.1 UI

**On `/access/applications/[id]`** — one card, **Access Review**, below the existing findings section: last reviewed date ·
reviewer display name + role · outcome badge · a one-line evidence summary (identity count, highest severity, freshness) · **Attest**
button. Card is rendered only for owner/admin (the page already gates that way).

**On `/apps/[id]`** *(if §3.2 ships in v1)* — one card, **Application Governance Review**, same shape. **Hidden entirely** for
non-owner/admin, because the host page admits more roles (§4.5).

**Attestation form** — shows the exact snapshot fields that will be frozen, with `frozen_at`, the freshness label, and any blocking
condition. Controls: Approved / Flagged for Review (native radio group), optional Notes (native `<textarea>` with counter), Cancel,
Submit. Blocked state (`bounded = true`) disables submit, states the reason, links to the live view.

> **Preview is advisory; the write is authoritative.** The form's preview and the write are separate reads at different instants.
> The snapshot frozen is the one assembled **at write time**, and the form says so. (This rule is carried from the deferred model,
> where getting it wrong was a blocker.)

**History** — a bounded, paginated list under the card: Date · Reviewer · Role · Outcome · Evidence summary · Note. Newest first,
server-ordered by `reviewed_at` with an `id` tie-break for determinism. Accessible, keyboard-operable, clear empty state, no raw
JSON, no destructive action.

**Accessibility** — visible focus; validation errors in a `role="alert"` summary with focus moved to it; success announced via
`role="status"`; outcome, severity and freshness conveyed by text, never colour alone; one `<h1>` per page state.

**Copy discipline** — never "Configuration verified", never "compliant", never "access is secure". The card says what was reviewed
and when, and nothing more.

## 6.2 Minimal conceptual data model

**`application_attestation`** — `id · tenant_id · subject_kind (directory_application | operational_app) · subject_row_id ·
review_type · outcome · note? · reviewed_at · reviewer_user_id · reviewer_display_name · reviewer_email · reviewer_tenant_role ·
evidence_snapshot · snapshot_schema_version · created_at`, plus `note_redacted_at/reason` and `reviewer_redacted_at/reason`.

`subject_kind` + `subject_row_id` (no FK, §7) is what lets one table serve both surfaces without a join that does not exist.

**`attestation_audit_event`** — `tenant_id · subject_kind · subject_row_id · attestation_id · review_type · outcome ·
actor_user_id · actor_tenant_role · event_type · occurred_at · snapshot_schema_version`. **No note, no snapshot, no prose.**

A **new** audit table, not `public.audit_logs`: that table's only policy is `is_tenant_member` (`0001:323`), so every viewer would
read every attestation event, contradicting §4.5; and its shipped DTO withholds the actor (`audit.ts`), the opposite of what an
attestation trail needs.

No campaign, item, assignment, approval, notification, scheduler, cadence, or remediation table. Latest state is **derived**, never
stored — the old app's mutable mirror is the defect being avoided.

## 6.3 Risks

| Risk | Mitigation |
|---|---|
| Snapshot asserts a field the read path does not return | Every §4.1/§4.2 field is traced to `ApplicationAccessDetailData` or `AppDetail`/`AppInventoryRow` in §1. PR B's gate is a test asserting the snapshot builder compiles against those exact return types |
| No cadence ⇒ no overdue signal | Disclosed in §4.8 and §5; "Never reviewed" and "last reviewed N days ago" are honest substitutes |
| No application index on the directory surface | Attestation history route doubles as the entry point (§6.4 PR C); the findings list and identity detail already link to application detail |
| Attestation card visible to wrong roles on `/apps/[id]` | Card hidden, not disabled; attestation tables carry their own owner/admin read policy (§4.5) |
| `bounded` applications can never be attested | Accepted and disclosed: an attestation over absent counts would be worse. Raising `SUBGRAPH_MAX_ROWS` is Phase-15 work, out of scope |
| Two subject kinds in one table | `subject_kind` discriminator; no FK to either application world (§7) |
| Reviewer role sourced wrongly | §4.6 states the `tenant_memberships.role` read explicitly |
| Retention promise with no enforcement | v1 makes **no** timed retention promise. Redaction is an explicit owner/admin act (§6.5). Nothing depends on a scheduler |

## 6.4 Phase 16B implementation sequence

| PR | Scope | Gate |
|---|---|---|
| **A** | Attestation + audit tables; owner/admin RLS read policy; zero DML grants to request roles; append-only enforcement (mirroring `reject_audit_mutation`, `0002:252-265`); audit-on-write trigger (the `0010` pattern, `auth.uid()` = caller); read/write DAL | Grant/policy matrix review; RLS suite proving editor/viewer/non-member/anon hold zero privilege; default-privileges regression test (the `0045` lesson) |
| **B** | Access Review snapshot builder over `loadApplicationAccessDetail`; reviewer snapshot incl. the `tenant_memberships.role` read; bounded-blocks-submission rule | **A test asserting every snapshot field exists on `ApplicationAccessDetailData`** — the single check that would have caught four prior specs' central defect. Month-free, scheduler-free |
| **C** | Access Review card + form + history on `/access/applications/[id]`; attestation history route (doubles as the entry point); accessibility | Manual owner/admin acceptance; keyboard + screen-reader pass |
| **D** | *(optional in v1)* Application Governance Review on `/apps/[id]`, reusing A–C machinery with a second snapshot builder; card hidden for non-owner/admin | Role-visibility test on a page that admits more roles |
| **E** | Bounded CSV export; write-acceptance runbook | Column allowlist + `sanitizeCsvCell`; a **write** runbook distinct from the read-only Phase-15 verifier, which `docs/73 §6` binds to read-only and which is not modified |

## 6.5 Privacy and retention

| Class | Fields | Exported | Erasure |
|---|---|---|---|
| Attestation fact | subject, review_type, outcome, `reviewer_user_id`, `reviewer_tenant_role`, timestamps | ✅ | never redacted — no directly identifying field |
| Reviewer identity | `reviewer_display_name`, `reviewer_email` | name ✅ / email ❌ | redactable to `"[redacted]"` on that reviewer's erasure request |
| Note | `note` | ✅ | redactable |
| Evidence snapshot | counts, enums, labels of **applications** (not people) | ✅ | retained — an attestation must say which application it concerned |
| Audit event | §6.2 fact set | ❌ | never redacted — carries no note, no snapshot, no identifying reviewer field |

Redaction is an explicit, audited, irreversible owner/admin act; it never deletes a row. **v1 sets no timed retention period**,
because enforcing one needs a scheduler that does not exist and §4 forbids. Tenant deletion cascades via `tenant_id`.

The snapshot carries **no person's name**: identity labels appear only in the live view, never in a frozen record.

## 6.6 Future roadmap

| Deferred | Named dependency |
|---|---|
| Cadence + Current/Overdue | net-new cadence storage, a UI control, a write path, and calendar arithmetic |
| Correlating the two application worlds | the canonical resolver — `apps.canonical_app_id` and `directory_applications.catalog_product_id` both exist and **neither is populated** (`0024:13-16`, `0057:10,20`) |
| Business justification / data classification review | the columns must exist first |
| Owner *names* rather than booleans | a deliberate reversal of `apps.ts:43`, needing a privacy review |
| Four-state freshness fidelity | a Phase-16 projection over subgraph rows (Phase 15 collapses at `access-loaders.ts:46`) |
| Per-identity certification, campaigns, reviewers, approvals | the full deferred model in `docs/reviews/PHASE_16A_ACCESS_REVIEW_SPEC_REVIEW.md` Parts I–IV |
| Attesting `bounded` applications | raising `SUBGRAPH_MAX_ROWS` or a paged evidence path |
| Privileged / high-risk signals | a privilege attribute in the canonical graph |

---

## 7. Subject references carry no foreign key

`subject_row_id` is a plain `uuid` with **no FK** to either application world. `identity_accounts` and its edges cascade from
`connectors` (`0053:59-61`, `0056:55-56`, `0059:57-58`), and `apps.canonical_app_id` is `ON DELETE SET NULL` (`0024:103`). A
cascading FK would destroy attestation history when a connector is removed; `RESTRICT` would make connectors undeletable. The frozen
`application_label` is what renders, so a record stays readable after its subject row is gone.

---

## Appendix A — RISK-007 and Phase C

From the authoritative sources: **RISK-007 is CLOSED at its staging-defined criteria** (`docs/04`; closure register `docs/65`,
R-018/PR #291). **Phase C is UNBLOCKED as a governance state only** (`docs/66`, R-019/PR #292 — it "does not run C-2c, does not run
connector live data-sync, does not touch production, and does not authorize any production action"). Entra and Okta remain
`certificationOnly`. `docs/55` still reads OPEN/BLOCKED and self-declares parts historical; where it conflicts, `docs/04`/`65`/`66`
govern.

**Phase 16 asserts only this:** it neither closes nor reopens any RISK-007 criterion and does not change the Phase C authorization
state. It touches no connector, credential, provider path, hosted task, AWS resource, or production resource. Production remains
untouched.
