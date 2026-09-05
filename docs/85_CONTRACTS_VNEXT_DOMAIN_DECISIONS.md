# 85 · Contracts vNext — Canonical Domain Decisions

**Canonical for: the contract-domain decisions that must be frozen before Contracts vNext writes any
schema.** This document decides *what the model means*. It does not implement, propose a migration,
or authorize one. Where a product decision is genuinely unresolved it says **DECISION REQUIRED** and
stops there rather than inventing a column.

- **Design direction of record:** Quiet Operations (selected 2026-09-04 from a three-way isolated
  design exploration; the prototype is not promoted and production `/contracts` is untouched).
- **Companion docs — read, not duplicated here:**
  [84_CONTRACT_ENTITLEMENT_INTELLIGENCE](./84_CONTRACT_ENTITLEMENT_INTELLIGENCE.md) (the purchased
  side and the five quantities) ·
  [13_CONTRACT_STEWARD_WRITE_DESIGN](./13_CONTRACT_STEWARD_WRITE_DESIGN.md) (write authority) ·
  [16_CONTRACT_PDF_AI_EXTRACTION_DESIGN](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) (documents +
  extraction trust model) · [02_SECURITY_AND_RLS](./02_SECURITY_AND_RLS.md) (the authorization
  model) · [v3-data-model.md](./v3-data-model.md) (the schema).
- **Status:** design / decisions-of-record. Nothing in this document is implemented.

---

## 0. How to read this

### Local status taxonomy
Maps onto [10_DOCS_INDEX](./10_DOCS_INDEX.md#status-taxonomy); these four are the only labels used
per topic.

| Label | Meaning |
|-------|---------|
| **CURRENT** | true in the repository today — a column, policy or DAL field that exists and is read |
| **DECIDED VNEXT** | the decision is frozen by this document; implementation still has to happen |
| **PROPOSED** | a shape we expect to build, but the product decision behind it is not yet frozen |
| **DEFERRED** | deliberately not built yet, with the condition that would revive it |
| **DECISION REQUIRED** | blocked on a human product/ownership call — no schema may be written for it |

**No topic below currently sits at PROPOSED, and that is the point of this exercise:** each of the 21
either reached a frozen decision or is explicitly **DECISION REQUIRED** with the migration it blocks
named. A topic that landed at PROPOSED would mean the decision had been dodged rather than made.

### The two rules that govern every decision below

1. **Unknown is not zero.** Every commercial quantity added by
   [0084](../supabase/migrations/0084_contract_entitlements.sql) is nullable on purpose. A missing
   fact renders as a sentence, never as `0` and never as a dash a reader would take for a zero. Any
   new field here inherits that rule.
2. **Provider fact ≠ normalized fact ≠ governance truth** (ENGINEERING_STANDARDS §D). For contracts
   the same three layers read: **document = source evidence · extraction = a proposed fact · the
   `contracts` column = the canonical value.** No decision below may collapse them.

### Repository truth this document was checked against

Read directly from the migrations and the DAL on 2026-09-05, not from memory:

| Fact | Evidence |
|------|----------|
| `profiles` is readable **own-row only** | `0001:276` — `create policy "users can read own profile" … using (id = auth.uid())`. No later migration widens it. |
| `people` **is** tenant-member readable | `0001:311` — `"members read people"`; carries `full_name`, `title`, `department`, `primary_email`, `manager_email`. |
| Contract read = tenant member **∪** procurement-org **∪** paying-org member | `0003:47–63` — `"org members read related contracts"`. |
| Contract write = tenant editor+ **or** procurement-org manager; paying org **never** | `0004`; [13](./13_CONTRACT_STEWARD_WRITE_DESIGN.md). |
| `organizations.type` has **no CHECK constraint** | `0001:33–41` — `type text not null default 'agency'`. |
| Contract edits are audited on a **curated allowlist**, `before_json` deliberately NULL | `0010:36–80` — no cost, date, notes or legal text enters `audit_logs`. |
| `files` already has `document_type`, `extraction_status` (CHECK), `extraction_result_json`, `sha256` | `0001:181–191` + `0012:35–59`; specified in [16 §4](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md). None is surfaced by the DAL. |
| `contracts` has **no** `vendor_id`; `contract_entitlements` does | `0084:91,165` vs `0001:69–88`. |
| Commercial findings are **computed per request**, not persisted | `src/lib/data/commercial-loader.ts`; contrast `governance_findings` (`0083`). |
| Same-tenant child integrity uses composite FKs `(id, tenant_id)` | `0005:29–42` — the pattern every new child table below must follow. |

---

## 1. Contract owner — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | `contracts.owner_user_id → profiles`. The DAL exposes it **only** as `hasOwner: boolean`; the raw id never leaves `src/lib/data/contracts.ts`. |
| **Problem** | Every vNext design needs "who owns this relationship" as a **name**. It cannot be rendered: `profiles` is own-row-read-only, so a user-scoped client can never resolve another member's id to a name. The instinct — widen `profiles` RLS — exposes every workspace member's email to every other member, far beyond contracts. |
| **Decision** | **Two distinct references, not one.** Keep `owner_user_id` as the *accountable ID Caddie user* (authority + future notification hook, still surfaced as a boolean). Add `owner_person_id → people` as the *named business owner*, which is what the UI displays. |
| **Rejected** | *Widen `profiles` RLS to tenant members* — a T3 trust-boundary change whose blast radius is the whole product, bought for one label. *Replace `owner_user_id` with a `people` reference* — loses the ability to ever act as/notify the owner. *Free text* — unjoinable, and `renewal_responsibility` already demonstrates the failure mode. |
| **Rationale** | It matches how procurement actually thinks: the owner is a person in the organization, not necessarily a login. It gets a name on screen without turning the member directory into a lookup service, and it keeps authority and identity separable. |
| **Cardinality** | Contract **N:1** person. A person owns many contracts. Exactly one owner per contract (co-ownership is not modelled — see Open). |
| **Lifecycle** | `people.employee_status` already exists. An owner whose person row goes inactive must raise a **"no effective owner"** attention flag. **Do not** cascade-null the FK on departure: that they owned it stays true, and nulling destroys the only record of who to ask. |
| **Tenancy** | `people` is already tenant-scoped and tenant-member readable — **no RLS change, no widening**. Same-tenant binding enforced by composite FK per `0005`. Ownership must **not** grant contract read: read stays the `0003` union. |
| **Migration** | Eventually: `contracts.owner_person_id uuid` + composite FK `(owner_person_id, tenant_id) → people(id, tenant_id)`. Nullable. No backfill possible — existing rows have no person reference. |
| **UI** | Detail → *Who owns and who pays*. Name + title + department. Where null: "No owner assigned" as an attention chip that is also the repair affordance. `hasOwner` stays the list-column signal. |
| **Open** | Co-ownership (business owner vs technical owner) — `apps` already has both (`business_owner_user_id`, `technical_owner_user_id`). Deferred until a customer asks; one owner plus §17's renewal owner covers Flywheel today. |

## 2. Procurement owner — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | `contracts.procurement_org_id → organizations`. It is doing **two jobs**: "who negotiated this" *and* "who may write to it" (`0004`: an org manager of this org may write). |
| **Problem** | The individual category manager who ran the negotiation has nowhere to live, and the obvious move — reuse the org field — would further overload a column that is load-bearing for **write authority**. |
| **Decision** | Freeze `procurement_org_id` as the **write-authority anchor, unchanged**. Add `procured_by_person_id → people` for the individual. The two are independent: the person is descriptive, the org is authoritative. |
| **Rejected** | *Derive the procurer from the audit log* — `0010` records the actor of the last write, which is whoever edited a field, not who negotiated the deal. *Reuse `owner_person_id`* — they are genuinely different people (§1 vs a category manager); the prototype fixture had them differ on 6 of 15 contracts. |
| **Rationale** | Separating authority from attribution is the same discipline `0004` already applies to `paying_org_id` (read, never write). A descriptive field must never silently become an authority field. |
| **Cardinality** | Contract **N:1** person, nullable. Contract **N:1** organization (existing). |
| **Lifecycle** | Historical. A procurer who leaves stays recorded — this is a fact about a past negotiation, not a live responsibility, so **no** attention flag on departure (unlike §1). |
| **Tenancy** | As §1. Being named as procurer grants **nothing**. |
| **Migration** | Eventually: `contracts.procured_by_person_id uuid` + composite FK. Nullable, no backfill. |
| **UI** | Detail → *Who owns and who pays*, visually subordinate to the owner. Never in the list. |
| **Open** | None. |

## 3. Paying organization — **CURRENT** (one bounded addition **DECIDED VNEXT**)

| | |
|---|---|
| **Current** | `contracts.paying_org_id → organizations`. Grants **read** via the `0003` union; **never** write (`0004`). `organizations` carries `parent_org_id` and `type`. The model is correct and stays. |
| **Problem** | Not the relationship — the **vocabulary**. `organizations.type` is `text not null default 'agency'` with **no CHECK**, so "holding company", "paying entity", "agency", "business unit" are convention held in nobody's head. Every vNext feature that reasons about org kind (beneficiary rollups, allocation, entity-level reporting) would be reasoning over free text. |
| **Decision** | Keep the relationship exactly as-is. **Bound `organizations.type`** with a CHECK: `holding` · `procurement` · `paying_entity` · `agency` · `business_unit` · `other`. |
| **Rejected** | *A separate `organization_kinds` table* — six stable values do not need a table with no reader. *Leave it free text* — every consumer then reimplements its own guess. |
| **Rationale** | Cheapest possible correctness win: one constrained column removes an entire class of downstream ambiguity. `other` keeps the constraint from becoming a migration blocker for an org shape we have not met. |
| **Cardinality** | Contract **N:1** organization. Unchanged. |
| **Lifecycle** | Organizations outlive contracts. `parent_org_id` re-parenting must not rewrite historical contracts. |
| **Tenancy** | **Unchanged and must be proven unchanged.** `paying_org_id` already grants read through `0003`; nothing here widens it. |
| **Migration** | Eventually: a CHECK on `organizations.type`, preceded by a **survey of existing values** — an unsurveyed CHECK will fail on live data. Existing unmapped values migrate to `other`, never dropped. |
| **UI** | Detail → *Who owns and who pays*; list column (short name). Already built. |
| **Open** | Whether `type` should be per-tenant configurable. Assumed no — these six describe a holding-company structure that Omnicom shares with every comparable customer. |

## 4. Benefiting organizations / business units — **DECIDED VNEXT** (one **DECISION REQUIRED**)

| | |
|---|---|
| **Current** | **Nothing.** A contract points only at procurement and paying orgs. "Which agencies actually benefit" is unrepresentable — the single largest gap the design exploration exposed. |
| **Problem** | Flywheel's central question ("Critical Mass, Commerce Cloud, BBDO and TBWA all use this Figma agreement — who carries it?") has no home. It is genuinely many-to-many, and it exists at two levels: a **contract** serves agencies; an **app instance** serves a business unit. |
| **Decision** | New join table `contract_beneficiaries (contract_id, organization_id, tenant_id, note)`, unique on `(contract_id, organization_id)`, same-tenant composite FKs per `0005`. Attach it to the **contract**, not the app. |
| **Rejected** | *An array column on `contracts`* — unjoinable, unconstrained, and cannot carry a per-beneficiary note or later an allocation. *Model it on `apps`* — `apps.responsible_org_id` already answers a *different* question ("who stewards this application"); Flywheel asks about the agreement. *Derive beneficiaries from discovered accounts* — that infers a commercial relationship from an access fact, exactly the collapse ENGINEERING_STANDARDS §D forbids. |
| **Rationale** | The contract is where the money is committed, so it is where the question "who benefits from this commitment" belongs. A join table is also the only shape that §6's allocation can hang off without a second modelling round. |
| **Cardinality** | Contract **M:N** organization. |
| **Lifecycle** | Beneficiaries change mid-term (Amendment 1 in the fixture added TBWA). The **current** set is a plain join; the **historical** set is §7's effective dating, which supersedes this table's temporality rather than duplicating it. |
| **Tenancy** | **DECISION REQUIRED — does beneficiary membership grant contract READ?** A yes changes the `0003` union and is a tenant-isolation decision, not a product one. **Default assumption for planning: NO.** Read stays procurement ∪ paying ∪ tenant member; beneficiary is descriptive only. If the answer is yes, it must arrive as its own reviewed RLS change with isolation proof — never as a side effect of adding the table. |
| **Migration** | Eventually: one new table. **Blocked** on the tenancy answer above, because the policy is part of the table's definition. |
| **UI** | Detail → *Who owns and who pays*, as chips. `PROPOSED` marker until shipped. Beneficiary rollup view is a later surface. |
| **Open** | The tenancy question above is the blocker. Also: does a beneficiary need a *share* (§6) or is membership enough? Membership first. |

## 5. Contract ↔ application relationship — **CURRENT** (surfacing **DECIDED VNEXT**)

| | |
|---|---|
| **Current** | `app_contracts (app_id, contract_id, tenant_id, relationship_type default 'primary')` with org-scoped read (`0006`, hardened `0009`). `listAppsLinkedToContract` selects **only `app_id`** — `relationship_type` exists and is never read. Separately, `contract_entitlements` may reference `app_id`, `app_product_id` and `vendor_id` (`0084`). |
| **Problem** | Three overlapping ways to say a contract concerns an application, and one of them (`relationship_type`) is invisible. Also: `contracts.vendor_name` is **free text with no `vendor_id`**, so "Figma" the contract and "Figma" the connector are unrelated strings (`0084` header). |
| **Decision** | (a) **Surface `relationship_type`** in the DAL and bound its vocabulary: `primary` · `secondary` · `bundled` · `superseded`. (b) Keep the entitlement-level references as the **precise** join — a purchased line names its product; the `app_contracts` link stays the **coarse** one. (c) Add `contracts.vendor_id → vendors` as a nullable canonical reference alongside the free-text name. |
| **Rejected** | *Collapse `app_contracts` into `contract_entitlements`* — a contract can concern an application before anyone records what was bought; the fixture has exactly this (Semrush, Slack draft). *Replace `vendor_name` with `vendor_id`* — destroys the recorded paper name; keep both, name is what the document said. *Infer the vendor by name matching* — `0084` rejected exactly this for measurement sources, for the same reason. |
| **Rationale** | Coarse and precise links answer different questions and neither subsumes the other. The canonical `vendor_id` is already listed as P1 in [84 §8](./84_CONTRACT_ENTITLEMENT_INTELLIGENCE.md); this document adopts it rather than re-deciding it. |
| **Cardinality** | App **M:N** contract (existing). Contract **N:1** vendor (new, nullable). |
| **Lifecycle** | `superseded` lets a replaced link stay visible rather than being deleted — consistent with `0004`'s no-destructive-delete posture. |
| **Tenancy** | Unchanged. `0006`/`0009` already bind link reads to the tenant and to readability of *either* side. |
| **Migration** | Eventually: CHECK on `relationship_type` (survey first); `contracts.vendor_id` + composite FK. Backfill by `vendors.normalized_name` is a **suggestion for human review**, never an automatic write. |
| **UI** | Detail → *What this covers*: application name, instance count, current account count, and the relationship type where it is not `primary`. |
| **Open** | None blocking. |

## 6. Allocation / chargeback — **DECIDED VNEXT** (structure and level) · extension **DEFERRED**

| | |
|---|---|
| **Current** | **Nothing.** No table, no percentage, no basis. `docs/v3-data-model.md` notes `invoices` as the eventual chargeback carrier, but invoices are default-deny and out of scope (RISK-002). |
| **Problem** | Three independent axes get conflated whenever anyone sketches this: **level** (whole contract vs a purchased line), **basis** (what kind of number 38% even is), and **time** (§7). Deciding them together produces a table nobody can validate. |
| **Decision** | **Contract-level first**, with the basis stored explicitly as an enum: `percentage` · `fixed_amount` · `by_quantity` · `by_headcount`. Shape: `contract_allocations (contract_id, organization_id, tenant_id, basis, value, effective_from, effective_to, note)`. Entitlement-level allocation is **DEFERRED** (§21). |
| **Rejected** | *Percentages only* — the fixture alone needed four different bases ("assigned seats at the last true-up", "headcount-weighted", "metered DBU consumption", "named client retainers"); a bare 38% with no basis is unauditable. *Derive allocation from discovered accounts* — that is an access fact, not a commercial agreement, and the split is frequently negotiated against something else entirely. *Store only a computed amount* — loses the rule, so it cannot be re-based next quarter. |
| **Rationale** | Every money figure must name the arithmetic that produced it — the rule the commercial engine already enforces for opportunity estimates. Storing the basis is what makes an allocation checkable by the agency being charged. |
| **Cardinality** | Contract **1:N** allocation rows; each row **N:1** organization. Within an effective period, `percentage` rows must sum to 100. |
| **Lifecycle** | See §7. Historical periods are immutable. |
| **Tenancy** | Follows the contract; adds no read path. An organization must **not** gain contract read by being allocated a share — same rule as §4, and for the same reason. |
| **Migration** | Eventually: one new table + a validation approach for the sum-to-100 rule (**Open**: DB constraint vs application-level check; a deferrable constraint across rows is awkward, and a partial split mid-edit is legitimate). |
| **UI** | Detail → *Money*: one compact stacked bar + legend with each organization's share **and its cash equivalent**. Absent: "No split agreed", never an implied 100% to the payer. |
| **Open** | Where sum-to-100 is enforced. Whether a `fixed_amount` split may under-allocate deliberately (an unallocated remainder carried centrally) — assumed **yes**, and the remainder must be shown, not hidden. |

> **Risk note.** Allocation is **financial authority** under ENGINEERING_STANDARDS §T3. It is T3
> regardless of what the path-based classifier scores on the diff, and this document does not
> de-escalate it.

## 7. Effective-dated allocations — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | **Nothing.** |
| **Problem** | Real splits re-base ("re-based each January", "monthly by metered consumption"). A mutable percentage column overwritten each quarter destroys the only record of what an agency was actually charged last quarter — and chargeback disputes are always about the past. |
| **Decision** | Allocation rows are **effective-dated and append-only in effect**: `effective_from` (NOT NULL) and `effective_to` (NULL = currently in force). Re-basing **closes** the old row and **inserts** a new one; it never updates a value in place. |
| **Rejected** | *Mutable percentages* — destroys history, as above. *A separate `allocation_history` audit table* — two places for the same truth, and the "current" table then has to be kept in sync with its own history. *Rely on `audit_logs`* — `0010` is contract-scoped, allowlisted, and deliberately excludes money (§11). |
| **Rationale** | The same reasoning `0084` applies to purchased lines (term-bounded facts, not mutable numbers) and that connector supersession (`0071`) applies to sources: a fact with a validity window is a different thing from a mutable setting. |
| **Cardinality** | One organization may hold **many** non-overlapping rows per contract. |
| **Lifecycle** | Overlapping periods for the same `(contract, organization)` are a **data error** and must be rejected. A closed period is immutable — corrections are a new period with a note, not an edit. |
| **Tenancy** | As §6. |
| **Migration** | Eventually: an exclusion/overlap guard. Postgres `daterange` + an `EXCLUDE` constraint is the obvious tool, and is the first place this domain would need `btree_gist` — call that out at migration time rather than discovering it in review. |
| **UI** | *Money* shows the **in-force** split by default, with the effective date beside it and prior periods behind a disclosure. |
| **Open** | Retroactive re-basing (correcting a closed period) — assumed **not permitted** in v1; a correction is a new period. |

## 8. Contract document kinds — **DECIDED VNEXT** (column **CURRENT**, unbounded)

| | |
|---|---|
| **Current** | `files.document_type` **exists** (`0001:187`) as free text with **no CHECK** and is **not selected by the DAL** — `listContractFilesForCurrentUser` returns filename, upload status and date only. `0012` added `content_type`, `byte_size`, `sha256`, `upload_status`, `scan_status`, `extraction_status` (bounded), `extraction_result_json`. |
| **Problem** | The storage exists; the *meaning* does not. A flat filename list cannot express that one document is the master agreement and another amends it. This corrects an earlier characterization in the productionization brief that document kind was wholly unmodelled — the column is there, unbounded and unread. |
| **Decision** | Bound `document_type`: `msa` · `order_form` · `amendment` · `sow` · `dpa` · `renewal_notice` · `invoice_backup` · `other`. Surface it in the DAL. |
| **Rejected** | *A new `document_kinds` table* — a stable closed vocabulary needs a CHECK, not a table. *Infer kind from filename* — the fixture filenames are conveniently descriptive; real ones are `scan_0042.pdf`. |
| **Rationale** | Consistent with how `0012` already bounded `upload_status` / `scan_status` / `extraction_status` — this is the one status-like column on `files` that was left open. |
| **Cardinality** | File **N:1** kind. Contract **1:N** files (existing `files.contract_id`). |
| **Lifecycle** | A document is immutable once uploaded (`sha256` exists to prove it). Reclassification changes the kind, never the bytes. |
| **Tenancy** | Unchanged — `files` RLS (`0013`) and the Storage object policies (`0014`) already govern this and are T34-tested. **No change to the storage boundary.** |
| **Migration** | Eventually: survey existing `document_type` values → map unknowns to `other` → add CHECK. Never drop a value. |
| **UI** | Detail → *What this covers*: kind + effective date, ordered per §9. Explicit states for `upload pending`, `not read`, `extraction failed`. |
| **Open** | Whether `other` needs a free-text qualifier. Assumed no for v1. |

## 9. Agreement / order form / amendment / renewal hierarchy — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | **Nothing.** Files attach to a contract as an unordered set. |
| **Problem** | "What are the terms in force today?" is unanswerable from an unordered set. The Figma fixture is the canonical case: MSA → order form → Amendment 1 (adds an affiliate) → Amendment 2 (1,200 → 1,850 seats, fee 315,240 → 486,000). The current terms are the *composition* of four documents. |
| **Decision** | Add `files.effective_date date`. The hierarchy is expressed by §10's supersession edges plus effective date — **not** by a document-order column. The "terms in force" view is a **derivation**, never a stored flag. |
| **Rejected** | *A `sequence` integer* — breaks the moment a back-dated amendment is uploaded. *A `parent_document_id` tree* — an amendment can amend an order form while a DPA amends nothing; a tree forces a false parent. *Store an `is_current` boolean per document* — a denormalization that goes stale on every upload, and there is no writer to keep it honest. |
| **Rationale** | Store the edges, compute the answer. The same choice `0074` makes for stale-aware counts: derive the current view from dated facts rather than maintaining a "current" flag that some path will forget to update. |
| **Cardinality** | Contract **1:N** documents; documents form a DAG (§10). |
| **Lifecycle** | Effective date is a **property of the paper**, distinct from `created_at` (when it was uploaded). The fixture has a document effective 2025-11-01 uploaded 2025-11-03, and a renewal quote with **no** effective date at all — nullable is correct. |
| **Tenancy** | Unchanged. |
| **Migration** | Eventually: `files.effective_date date` nullable. No backfill — unknown stays unknown. |
| **UI** | Detail → an ordered, effective-dated trail with kind and read-state. Amendment **deltas** ("Purchased seats 1,200 → 1,850") are derived from §11 provenance, **not** hand-entered — a hand-entered delta is a third place for the truth to disagree. |
| **Open** | Whether an amendment with no effective date sorts by upload date or sorts last. Assumed: sorts last, marked "no effective date". |

## 10. Document supersession — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | **Nothing.** |
| **Problem** | Supersession is not a chain. Amendment 2 supersedes the order form's quantities while the DPA supersedes nothing and the MSA is superseded by neither. A linked list is the wrong shape and will be wrong on the second real contract. |
| **Decision** | `files.supersedes_file_id uuid` — a self-reference forming a **DAG**, with a same-tenant composite FK. Cycles must be refused. |
| **Rejected** | *An ordered chain / linked list* — cannot express partial supersession. *A `superseded_by` inverse* — the same edge stored twice, guaranteed to disagree. *A separate edge table* — one nullable self-FK covers every case the domain has produced; an edge table would be reached for only if a document could supersede several documents independently, which is the Open below. |
| **Rationale** | Smallest structure that holds the real shape. Consistent with connector supersession (`0071`), which already models "this replaced that" as a declared edge rather than an inferred order. |
| **Cardinality** | File **N:0..1** superseded file, as decided. See Open. |
| **Lifecycle** | A superseded document stays readable forever — it is the evidence for what the terms *were*. Never deleted, never hidden. |
| **Tenancy** | Same-tenant composite FK per `0005`. |
| **Migration** | Eventually: `files.supersedes_file_id` + composite FK + a cycle guard. A single self-FK cannot express a cycle of length 1 without a CHECK (`id <> supersedes_file_id`); longer cycles need application-level or trigger validation — decide at migration time. |
| **UI** | The trail renders supersession visually; a superseded document is legible, not struck out. |
| **Open** | Whether one document may supersede **several** (e.g. a consolidated restatement replacing an MSA *and* two amendments). If yes, this becomes an edge table. **Assumed single for v1** — revisit before writing the migration, because it changes the shape rather than extending it. |

## 11. Field-level provenance — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | Entitlements already have the pattern: `contract_entitlements.source` (5 bounded values), `.confidence` (high/medium/low), `.evidence_file_id`, `.evidence_note` (`0084`). The **contract header has none of it**. `audit_logs` records `contract.created`/`.updated` on a **curated allowlist** with `before_json` deliberately NULL (`0010`) — so there is no field history for dates, cost or notes, by design. |
| **Problem** | "Where did the renewal date come from?" is unanswerable for every field on the contract header. The tempting fix — widen the `0010` allowlist — would push cost, dates and legal text into `audit_logs`, undoing an explicit security decision ([16 §8](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)). |
| **Decision** | A **separate** `contract_field_provenance (contract_id, field_name, source_file_id, page_number, text_span, extraction_confidence, verification_state, verified_by, verified_at, tenant_id)`. Provenance is a **product feature** with its own table; the audit log remains a **security** record and is not touched. |
| **Rejected** | *Widen the `0010` audit allowlist* — reverses a deliberate security decision and puts legal text in a table read by different eyes for different reasons. *Columns on `contracts` (`renewal_date_source_file_id`, …)* — one pair of columns per field, forever. *A JSONB blob on `contracts`* — unqueryable, unconstrained, and no FK to the evidence file. |
| **Rationale** | Provenance is per-field and sparse; a narrow table is the natural shape. Keeping it out of `audit_logs` preserves both records' meanings — one answers "what did the paper say", the other "who changed it". |
| **Cardinality** | Contract **1:N** provenance rows, at most one **current** row per `field_name`. |
| **Lifecycle** | A provenance row survives the value changing — it records what a document said at a point in time. Superseding evidence (§10) adds a row; it does not delete the old one. This is what makes §9's amendment deltas derivable. |
| **Tenancy** | Follows the contract; same-tenant composite FKs to both `contracts` and `files`. Grants no read of a file the caller could not already read. |
| **Migration** | Eventually: one new table. `field_name` must be constrained to the **writable contract field vocabulary** already defined by `parseContractWriteInput` — a provenance row for a field that cannot be written is meaningless. |
| **UI** | A small source chip (`§3.2`) beside a value, opening an evidence panel over the Quiet Ops detail. **"no source recorded"** renders wherever provenance is absent — the strongest honesty device in the design exploration. |
| **Open** | Whether provenance is required for a manual edit (a human typing a renewal date from an email). Assumed: allowed with `source = manual_entry` and no file — mirroring `contract_entitlements.source`. |

## 12. Verification / confidence — **DECIDED VNEXT** (AI generation itself **DEFERRED**)

| | |
|---|---|
| **Current** | `contract_entitlements.confidence` (high/medium/low) exists and is enforced by CHECK. The commercial engine already **caps** finding confidence by the provenance of the entitlement it derives from — arithmetic over a low-confidence manual entry cannot yield a high-confidence finding. `files.extraction_status` exists and is never written. |
| **Problem** | Confidence (how sure the *source* is) and verification (whether a *human* has confirmed it) are different facts and get merged constantly. An AI extraction at 0.94 confidence that nobody has looked at is not the same as a figure a procurement lead confirmed against paper. |
| **Decision** | Keep them **separate columns** on §11's table. `extraction_confidence numeric` (nullable; only meaningful for machine-derived values) and `verification_state` ∈ `unverified` · `ai_suggested` · `human_verified` · `disputed`. The **canonical value never lives here** — it stays the `contracts` column. |
| **Rejected** | *One combined "trust score"* — collapses two independent facts into a number nobody can act on. *A boolean `verified`* — no room for `disputed`, which is a real state when an agency challenges a figure. *Store confidence on `contracts`* — makes the canonical row carry a claim about itself. |
| **Rationale** | Preserves the three-layer separation (document → proposed fact → canonical value) that [16 §7](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) already mandates for extraction, and extends it to human entry. `disputed` is what makes a chargeback conversation representable. |
| **Cardinality** | 1:1 with a provenance row. |
| **Lifecycle** | `unverified` → `human_verified` on review; → `disputed` on challenge; a superseding document resets a field to `ai_suggested`/`unverified` rather than silently inheriting the old verification. |
| **Tenancy** | `verified_by` references a **person or profile** — this reopens §1's question in miniature. **Use `people`** for display consistency, or store `auth.uid()` and render it only as "verified" without a name. Prefer the latter for v1: no new exposure. |
| **Migration** | Eventually: columns on §11's table; CHECK on `verification_state`. |
| **UI** | A verified field is unremarkable; an unverified or disputed one is marked. Never a percentage badge on every field — the noise would defeat the purpose. |
| **Open** | Whether `human_verified` expires (a figure verified 18 months ago against a superseded document). Assumed: supersession resets it (Lifecycle above), no time-based expiry. |

## 13. `total_cost` semantics — shape **DECIDED VNEXT**, backfill **DECISION REQUIRED**

| | |
|---|---|
| **Current** | `contracts.total_cost numeric(14,2)` + `currency` + nullable `billing_frequency`. **The column carries no period.** |
| **Problem** | For a contract whose cadence is `monthly`, the workspace genuinely cannot say whether the figure is the month, the year, or the term. The prototype refuses to annualize rather than guess; production should not have to refuse. This is the single highest-value cheap correctness fix in the domain. |
| **Decision (shape)** | Add `total_cost_basis` ∈ `annual` · `monthly` · `quarterly` · `term_total` · `one_time`, plus `term_months integer` (required only when basis is `term_total`). Keep `total_cost` **as recorded** — never overwrite it with a computed figure. |
| **DECISION REQUIRED (data)** | **What do the existing rows mean?** The column cannot be made NOT NULL, nor can any annualized figure be trusted, until a human states the rule for legacy rows. This is a **data decision, not a code decision**, and may need to be per-contract. Until it is answered: no migration, and the UI keeps refusing to annualize. |
| **Rejected** | *Infer basis from `billing_frequency`* — the two are different facts. A contract billed monthly can perfectly well record an annual commitment; the Datadog fixture case (`monthly` cadence, a committed annual host count) is exactly this. *Default everything to `annual`* — silently invents a number for every mis-assumed row, and the error is invisible. *A second `annual_value` column* — two money columns that will disagree. |
| **Rationale** | Making the period explicit turns §16's annualized value from a guess into a derivation, and unblocks renewal-exposure figures across the portfolio. |
| **Cardinality** | 1:1 with the contract. |
| **Lifecycle** | Basis is a property of how the deal was written; it changes only by amendment. |
| **Tenancy** | None. |
| **Migration** | Eventually: `total_cost_basis` (nullable **first**, NOT NULL only after backfill) + `term_months`. Backfill blocked on the decision above. |
| **UI** | *Money* shows the recorded value **with its basis stated**, and the derived annualized figure beside it (§16). Where basis is unknown: the current honest refusal sentence. |
| **Open** | The backfill rule. **This is on the pre-implementation list.** |

## 14. Committed term value — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | Not represented. A multi-year commitment (the Databricks fixture: USD 2,150,000 over 36 months) can only be recorded by putting the whole-term number in `total_cost`, which is exactly the ambiguity §13 describes. |
| **Problem** | Total contract value and annual fee are different commercial facts and both matter — TCV for negotiation leverage, annual for budget. |
| **Decision** | **Do not add a column.** Committed term value is **derived**: `total_cost` + `total_cost_basis` + `term_months` (or `start_date`/`end_date`) are sufficient. Where basis is `term_total`, the recorded value *is* the TCV. |
| **Rejected** | *A `total_contract_value` column* — a second money column derivable from the first, guaranteed to drift. *Sum the entitlement lines* — lines are term-scoped and often incomplete (three fixture contracts have no lines at all); a partial sum understates and looks authoritative. |
| **Rationale** | One recorded money fact per contract, with its period named. Everything else is arithmetic — the same discipline the commercial engine already applies to opportunity estimates. |
| **Cardinality** | Derived, none. |
| **Lifecycle** | Recomputes as the term changes. |
| **Tenancy** | None. |
| **Migration** | **None.** Depends only on §13. |
| **UI** | *Money*, secondary to the recorded value, with the arithmetic available. Refuses where §13's basis is unknown. |
| **Open** | Whether a ramped deal (Salesforce: 900 → 1,400 → 1,900 users) can express TCV without per-year rows. It cannot from the contract header alone — the ramp lives in the entitlement lines' terms, so a ramped TCV is entitlement-derived (§21). Marked as a known limitation, not a blocker. |

## 15. Recurring amount — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | Not represented distinctly; conflated into `total_cost`. |
| **Problem** | "What do we pay per period" is the question a budget holder asks, and it is not always the recorded figure. |
| **Decision** | **Derived**, not stored: recurring amount = `total_cost` normalized to `billing_frequency` using `total_cost_basis`. Where basis is `one_time`, there is **no** recurring amount — and the correct answer is that sentence, not zero. |
| **Rejected** | *A `recurring_amount` column* — third money column, same drift argument as §14. |
| **Rationale** | `PERIODS_PER_YEAR` already exists in the commercial engine and bounds exactly which cadences can be normalized (`monthly`/`quarterly`/`annual`); `multi_year` and `one_time` correctly yield no figure. Reuse it rather than re-deriving. |
| **Cardinality** | Derived. |
| **Lifecycle** | n/a. |
| **Tenancy** | None. |
| **Migration** | **None.** |
| **UI** | *Money*, shown only where derivable. |
| **Open** | None. |

## 16. Annualized value — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | The prototype computes it and **refuses** wherever the period is ambiguous, `multi_year`, or `one_time`. Production `/contracts` does not compute it at all. |
| **Problem** | Every portfolio figure (committed spend, renewal exposure) needs a comparable per-year number, and today it either does not exist or has to be caveated. |
| **Decision** | **Derived from §13**, never stored. Reuse the engine's `PERIODS_PER_YEAR`. A contract whose basis is `term_total` annualizes over `term_months`; `one_time` yields no annual figure and says so. |
| **Rejected** | *Store an annualized figure* — same drift argument; also goes stale on amendment. *Annualize `multi_year` by guessing a term* — the engine already refuses this and the refusal is correct. |
| **Rationale** | One recorded fact, many derivations. Consistent with the engine's existing `Opportunity`/`Measure` discipline, where a figure that cannot be computed is a sentence rather than a null. |
| **Cardinality** | Derived. |
| **Lifecycle** | n/a. |
| **Tenancy** | **Never summed across currencies.** There is no FX source anywhere in the system; a combined total would be a fabricated conversion. Portfolio figures are per-currency, always. |
| **Migration** | **None.** |
| **UI** | *Money* + the per-currency committed strip on the list. |
| **Open** | Whether an FX source is ever introduced. **DEFERRED** — out of scope, and until it exists no surface may combine currencies. |

## 17. Renewal owner — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | `contracts.renewal_responsibility text default 'unknown'` — **free text, not a person reference**. The fixture values are real-shaped ("Global Procurement — software category team", "EMEA procurement, with Global Procurement sign-off above EUR 500k"). |
| **Problem** | Free text cannot be assigned, notified, filtered, or held accountable. But it is also carrying genuine nuance that a bare person FK would destroy. |
| **Decision** | **Both, with different jobs.** Add `owner_person_id` to §18's renewal-cycle row (the person accountable **for this renewal**, which is often not the contract owner). **Keep `renewal_responsibility`** as the free-text description of the *arrangement* (approval thresholds, committee sign-off) — renamed in the UI, not dropped. |
| **Rejected** | *Replace the free text with an FK* — loses "with Global Procurement sign-off above EUR 500k", which is the kind of thing that decides whether a renewal is actually approved. *Reuse the contract owner* — they differ; a contract owned by Flywheel RevOps can have a renewal run by Global Procurement. |
| **Rationale** | A structured assignee and an unstructured policy note answer different questions; forcing one to be the other loses information either way. |
| **Cardinality** | Renewal cycle **N:1** person. |
| **Lifecycle** | Per **cycle** — the renewal owner may change between cycles, and that history is worth keeping. |
| **Tenancy** | As §1 (`people`, no widening). |
| **Migration** | Eventually: a column on §18's table. `renewal_responsibility` is **unchanged**. |
| **UI** | Detail → *Time* / renewal panel. Where absent on a contract inside its notice window: an attention flag. |
| **Open** | None. |

## 18. Renewal workflow / tasks / decisions — **DECIDED VNEXT** (tasks **DEFERRED**)

| | |
|---|---|
| **Current** | **Nothing.** Dates exist; nothing has a state. `notice_deadline` is **stored**, which means it silently goes stale the moment a term rolls — a live bug class today, not a vNext concern. |
| **Problem** | The two genuine holes in the Flywheel journey are "record the renewal decision" and "allocate". A renewal is a *recurring* event with an owner, a deadline, a decision and an outcome, and none of it is representable. |
| **Decision** | `contract_renewals`, one row **per renewal cycle**, not per contract: `(contract_id, tenant_id, cycle_start, cycle_end, notice_deadline, decision_state, owner_person_id, target_outcome, final_outcome, vendor_quote_id, decided_at, decided_by, note)`. `decision_state` ∈ `not_started` · `in_review` · `notice_served` · `renewing` · `terminating` · `renegotiating` · `closed`. **`notice_deadline` becomes derived** where the term expresses it (e.g. 30 days before end), stored only where the paper is irregular. |
| **Rejected** | *State columns on `contracts`* — one cycle only, no history; "we took the 14.8% uplift last year" becomes unanswerable. *A general task system* — a renewal has an owner, a deadline and a state; a task engine is a product we are not building, and tasks can attach to the cycle later if genuinely needed. *Derive state from findings* — findings are recomputed per request and stateless by design. |
| **Rationale** | Per-cycle is what makes renewal history exist. Deriving the notice deadline removes an entire class of silent staleness. |
| **Cardinality** | Contract **1:N** renewal cycles; at most one **open** cycle at a time. |
| **Lifecycle** | `not_started` → `in_review` → one of `notice_served` / `renewing` / `terminating` / `renegotiating` → `closed`. **A served notice is irreversible in the record** — a reversal is a new state with a note, never an edit, and every transition is audited. |
| **Tenancy** | Follows the contract; write authority is the existing contract write rule (`0004`), **not** a new one. Paying-org members must not gain the ability to serve notice. |
| **Migration** | Eventually: one new table + an audit trigger following `0010`'s pattern (**and** its restraint about what enters `after_json`). Stateful workflow with an external, irreversible consequence ⇒ **T3**. |
| **UI** | Detail → *Time*: the "if nothing is done" sentence, the derived deadline, the decision state, and a renewal panel. |
| **Open** | Whether cycles are **generated** in advance (a row per anticipated renewal) or created on first interaction. Assumed: **on first interaction**, so the table holds decisions rather than speculation. |

## 19. Vendor renewal quote — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | **Nothing.** In the fixture the Adobe FY27 quote (EUR 703,000, +14.8%) exists only as an attached PDF with no structure — while being the most decision-relevant number on the screen. |
| **Problem** | The obvious shortcut — put the quote in `total_cost` — would overwrite a **commitment** with a **proposal**. |
| **Decision** | Model it explicitly: `vendor_quotes (contract_id, tenant_id, quoted_amount, currency, quoted_basis, quote_date, valid_until, source_file_id, status, note)`, `status` ∈ `received` · `under_review` · `accepted` · `rejected` · `expired`. `quoted_basis` reuses §13's vocabulary. **`total_cost` is never touched by a quote**; an accepted quote becomes a contract amendment through the normal write path. |
| **Rejected** | *Overload `total_cost`* — destroys the record of what we are actually committed to. *A note field* — unqueryable; renewal exposure cannot see it. *Model it as a `files` row only* — a document is evidence, not a structured claim. |
| **Rationale** | A quote is a **proposal by a counterparty** — structurally the same kind of thing as an AI extraction: a claim with a source and a status, not a fact about our commitment. Giving it the same shape keeps the three-layer separation intact. |
| **Cardinality** | Contract **1:N** quotes (renegotiation produces several); a renewal cycle references **at most one** current quote. |
| **Lifecycle** | `valid_until` makes expiry explicit rather than inferred. A rejected quote is retained — it is the negotiation history. |
| **Tenancy** | Follows the contract; `source_file_id` composite-FK'd same-tenant. |
| **Migration** | Eventually: one new table. |
| **UI** | *Money* → "Vendor position": the proposed figure, the delta against the recorded value, the status, and its source document. Never merged into the committed figure. |
| **Open** | Whether a quote can exist without a contract (a proposal for something not yet bought). **DEFERRED** — out of scope; a pre-contract proposal is a draft contract, which the model already supports via `status = 'Draft'`. |

## 20. Negotiation target — **DECISION REQUIRED**

| | |
|---|---|
| **Current** | **Nothing.** |
| **Problem** | "What are we trying to achieve at this renewal" (hold flat / reduce 200 seats / consolidate two agreements) is what a procurement lead wants recorded before the vendor call — but it is ambiguous whether it is a **structured objective** (comparable, reportable, "did we hit target?") or a **negotiation note** (freeform strategy). The two imply very different models, and one of them is arguably sensitive enough that it should not sit beside data a paying-org member can read. |
| **Decision** | **DECISION REQUIRED.** No schema is proposed. Three candidate shapes, deliberately left open: (a) `target_outcome` as a **bounded enum** on §18's cycle (`hold_flat` · `reduce_quantity` · `reduce_price` · `consolidate` · `terminate` · `renew_as_is`) — comparable and reportable, but loses nuance; (b) a **free-text objective** — expressive, unreportable; (c) **both**, mirroring §17's resolution. |
| **Rejected** | Nothing yet — rejecting an option before the product question is answered would be inventing the decision. |
| **Rationale** | The productionization brief listed a `target_outcome` column in §18's sketch. On inspection that pre-judged this question, so it is pulled out here and explicitly unresolved. |
| **Cardinality** | Per renewal cycle, if it exists at all. |
| **Lifecycle** | Would be set before a negotiation and compared against `final_outcome` after. |
| **Tenancy** | **The open risk.** A negotiating position is more sensitive than a contract fact, and contract read includes **paying-org members** (`0003`) — i.e. potentially the agency being charged. If a target is stored on the cycle it inherits that read. This must be answered before, not after, the column exists. |
| **Migration** | **None until decided.** |
| **UI** | None until decided. |
| **Open** | (i) enum, free text, or both; (ii) **who may read it**, given `0003`; (iii) whether "did we hit target?" is a reporting requirement or a nice-to-have. Until (i)–(iii) are answered, §18 ships **without** `target_outcome`. |

## 21. Entitlement-level vs contract-level commercial facts — **DECIDED VNEXT**

| | |
|---|---|
| **Current** | Both levels already exist and are correctly separated. **Contract level:** `total_cost`, `currency`, `billing_frequency`, dates (`0001`/`0011`). **Line level:** `contract_entitlements` — sku, plan, purchased/minimum quantity, unit amount, cadence, term, declared measurement source, `source`, `confidence`, evidence (`0084`). |
| **Problem** | Every new commercial fact (§6 allocation, §11 provenance, §19 quotes) has to be placed at one level or the other, and placing them all at both doubles the model for a minority of cases. |
| **Decision** | **A general placement rule, frozen here:** a fact belongs at the **line** level if it varies by product or SKU; at the **contract** level if it is a property of the agreement as a whole. Applying it: allocation → **contract** (v1) · provenance → **contract header** (lines already have their own) · quotes → **contract** · renewal cycle → **contract** · commitment amount → **contract**, quantities → **line**. |
| **Rejected** | *Everything at the line level* — three of fifteen fixture contracts have **no** lines at all; a model that cannot describe a contract until someone types an order form is unusable. *Everything at the contract level* — cannot express a ramp, a per-SKU minimum, or a per-product measurement source, all of which `0084` already handles correctly. |
| **Rationale** | The rule is falsifiable and settles future arguments without re-litigating each field. It also protects `0084`'s central discipline: the five quantities are line-level facts and must never be flattened onto the contract. |
| **Cardinality** | Contract **1:N** entitlements (existing). |
| **Lifecycle** | Lines are term-bounded (`term_start`/`term_end`) and a renewal creates **new** lines rather than mutating old ones — the existing behaviour, preserved. |
| **Tenancy** | `0084`'s RLS derives from the parent contract. Every new child table above follows the same rule. |
| **Migration** | **None** — this is a placement rule, not a schema change. |
| **UI** | Contract-level facts in *Money* and *Time*; line-level facts in *Purchased lines*, where the five quantities stay side by side and uncombined. |
| **Open** | **Entitlement-level allocation is DEFERRED** (§6). Revive when a customer needs to charge two business units different shares *of the same contract's different products* — a real case, but not Flywheel's first one. |

---

## 22. Decision ledger

### Frozen by this document (implementation may proceed once the pre-work below clears)

| # | Decision |
|---|---|
| 1 | Named owner = `owner_person_id → people`; `owner_user_id` retained as the authority hook; departure raises "no effective owner" |
| 2 | `procurement_org_id` stays the write anchor; `procured_by_person_id` added for attribution |
| 3 | Paying-org relationship unchanged; `organizations.type` gains a bounded CHECK |
| 4 | `contract_beneficiaries` join table on the **contract** (tenancy question below still open) |
| 5 | `relationship_type` surfaced + bounded; entitlement refs stay the precise join; `contracts.vendor_id` added |
| 6 | Allocation is **contract-level** with an explicit stored `basis` |
| 7 | Allocations are **effective-dated**; re-basing closes and inserts; closed periods immutable |
| 8 | `files.document_type` bounded to eight values and surfaced |
| 9 | `files.effective_date` added; "terms in force" is **derived**, never stored |
| 10 | Supersession is a **DAG** via `supersedes_file_id` (single-parent assumption flagged) |
| 11 | `contract_field_provenance` as a separate table; `audit_logs` untouched |
| 12 | `extraction_confidence` and `verification_state` kept as **separate** columns |
| 13 | `total_cost_basis` + `term_months` (shape only — backfill blocked) |
| 14 | Committed term value is **derived**; no column |
| 15 | Recurring amount is **derived**; no column |
| 16 | Annualized value is **derived**; never summed across currencies |
| 17 | Renewal owner as an FK on the cycle **and** `renewal_responsibility` retained as free text |
| 18 | `contract_renewals` **per cycle**; notice deadline becomes derived; no task system |
| 19 | `vendor_quotes` modelled explicitly; `total_cost` never overloaded |
| 21 | Placement rule: varies by product ⇒ line; property of the agreement ⇒ contract |

### Still open — must be answered before the corresponding migration

Two classes, deliberately distinguished. **§4, §13 and §20 carry `DECISION REQUIRED` in their
headings**: they are product/ownership calls that block a whole topic, and no schema may be written
for them at all. **§6, §10 and §12 are frozen decisions with an implementation question inside them**
— the shape is settled; how to enforce or express one part of it is not. Both classes block their
migration; only the first blocks the decision.

| # | Open question | Blocks | Owner |
|---|---|---|---|
| 4 | **Does beneficiary membership grant contract READ?** Changes the `0003` union — a tenant-isolation decision, not a product one. Planning default: **no**. | `contract_beneficiaries` | Sam + security review |
| 13 | **What do existing `total_cost` rows mean?** A data decision, possibly per contract. Cannot be inferred. | `total_cost_basis`, and every annualized figure | Sam / Tim |
| 20 | **Negotiation target: enum, free text, or both — and who may read it**, given paying-org read. | `target_outcome` on §18 | Sam / Tim |
| 10 | May one document supersede **several**? Changes the shape (self-FK → edge table). | supersession migration | Sam |
| 6 | Where is sum-to-100 enforced (DB constraint vs application)? | allocation migration | implementer + DB reviewer |
| 12 | Does `verified_by` name a person, or render as an unattributed "verified"? | provenance columns | Sam (privacy posture) |

### Deferred, with the condition that revives each

| Topic | Revive when |
|---|---|
| Entitlement-level allocation (§21) | a customer needs different shares per product on one contract |
| Co-ownership / business vs technical owner (§1) | a customer asks; `apps` already has the pattern to copy |
| A renewal task system (§18) | owner + deadline + state proves insufficient in real use |
| FX / cross-currency totals (§16) | a rate source with a recorded as-of date exists |
| AI extraction writing provenance rows (§11/§12) | [16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)'s extraction path is actually built |
| Invoices / observed spend | RISK-002 and `docs/63`'s sequencing; unchanged by this document |

---

## 23. What this document does **not** do

- **No migration, no schema.** Every "Migration" row says *eventually*. Nothing here authorizes a
  migration, and three decisions are explicitly blocked on human answers.
- **No RLS change.** The `0003` read union and `0004` write authority are unchanged. §4's tenancy
  question is raised precisely so it cannot be smuggled in as a side effect of adding a table.
- **No AI.** [16 §7](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md) already governs extraction:
  suggestions only, never a write; strict allowlist; the PDF is data, never instructions. This
  document extends that prohibition to **owner and allocation** — authority-bearing and financial
  references stay human — and otherwise defers to 16.
- **No claim of readiness.** Nothing here changes the cutover posture in
  [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md).
