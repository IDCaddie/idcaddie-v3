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

These five label the **topic**. `BLOCKED`, used in the *Migration* row of several topics, labels the
**migration** instead — a different axis: a topic can be frozen while its migration is blocked by
something in another topic (§12 is exactly this). Never use `BLOCKED` as a topic status.

**No topic below currently sits at PROPOSED, and that is the point of this exercise:** each of the 21
either reached a frozen decision or is explicitly **DECISION REQUIRED** with the migration it blocks
named. A topic that landed at PROPOSED would mean the decision had been dodged rather than made.

### Capability has five layers, and "the schema can store it" is only the first

Independent review found this document's first revision calling capabilities supported because a
column existed. A relationship is only *supported* when all five layers below hold; where any one is
missing the topic says so, and a topic missing a **read path** or **settled authority** may not be
frozen. This is the same discipline ENGINEERING_STANDARDS §D applies to provider vs normalized vs
governance fact, applied to product capability.

| Layer | Question |
|-------|----------|
| **STORAGE EXISTS** | is there a column/table? |
| **WRITE PATH EXISTS** | can any user-facing path actually set it? (`ContractWriteInput` is the contract answer) |
| **READ PATH EXISTS** | does a DAL return it — **and to every reader authorized to read the parent**? |
| **UI CONSUMES IT** | does a surface render it? |
| **AUTHORITY IS SETTLED** | is it decided who may set it, and does RLS enforce that? |

Applied to the three ownership fields, from source:

| Field | Storage | Write path | Read path | UI | Authority |
|-------|---------|-----------|-----------|-----|-----------|
| `contracts.owner_user_id` | ✅ `0001` | ❌ **none** — no `owner*` key in `ContractWriteInput`; `parseContractWriteInput` never emits `owner_user_id` | ⚠️ boolean only (`hasOwner`) | ⚠️ boolean badge | ❌ undecided |
| `contracts.procurement_org_id` | ✅ `0001` | ✅ `ContractWriteInput.procurementOrgId` | ✅ id → name via RLS-visible orgs | ✅ | ✅ `0002` as hardened by `0004` |
| `contracts.renewal_responsibility` | ✅ `0001` | ⚠️ writable but **never clearable** — `contract-write.ts:178–179` sets the column only when non-null | ✅ free text | ✅ | ✅ contract-write rule |

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
| Contract write = tenant editor+ **or** procurement-org manager; paying org **never**; no DELETE | Established across three migrations, not one: `0001:301` (tenant editor+), `0002:170` (org manager, keyed on `procurement_org_id`), both split into INSERT/UPDATE with no DELETE policy by `0004:48–51,86–91`. [13](./13_CONTRACT_STEWARD_WRITE_DESIGN.md). |
| `organizations.type` has **no CHECK constraint** | `0001:33–41` — `type text not null default 'agency'`. |
| Contract edits are audited on a **curated allowlist**, `before_json` deliberately NULL | `0010:36–80` — no cost, date, notes or legal text enters `audit_logs`. |
| `files` already has `document_type`, `extraction_status` (CHECK), `extraction_result_json`, `sha256` | `0001:181–191` + `0012:35–59`; specified in [16 §4](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md). None is surfaced by the DAL. |
| `contracts` has **no** `vendor_id`; `contract_entitlements` does | `0084:91,165` vs `0001:70–89` (the `contracts` table body). |
| Commercial findings are **computed per request**, not persisted | `src/lib/data/commercial-loader.ts`; contrast `governance_findings` (`0083`). |
| Same-tenant child integrity uses composite FKs `(id, tenant_id)` | `0005:29–42` — the pattern every new child table below must follow. |
| **READ-SCOPE ASYMMETRY — `contracts` is org-union readable; `people` and `files` are not** | `contracts` SELECT = tenant member ∪ procurement-org ∪ paying-org (`0003:47–63`). `contract_entitlements` SELECT derives from the parent contract (`0084:202–209`) so it **matches**. But `files` SELECT = `is_tenant_member(tenant_id)` (`0013:53–54`) and `people` SELECT = `is_tenant_member(tenant_id)` (`0001:311`) — **strictly narrower**. An org-scoped reader (a procurement-org manager, a paying-entity member) can read a contract and its purchased lines but **cannot read any document or any person**. Org-scoping `people` is explicitly gated by **RISK-002**, which states `people` + `identity_accounts` are *intentionally* not org-scoped. |

---

## 1. Contract owner — **DECISION REQUIRED** *(reopened by review; was DECIDED VNEXT)*

| | |
|---|---|
| **Current** | `contracts.owner_user_id → profiles` — **storage only**. Verified across all five layers: **no write path** (there is no `owner*` key in `ContractWriteInput`, and `parseContractWriteInput` never emits `owner_user_id`, so *nothing in the product can set an owner today*); read path is `hasOwner: boolean` only; UI renders that boolean; **authority is undecided** (nobody has ruled on who may assign an owner). |
| **Problem** | Three problems, not one. (a) `profiles` is own-row-readable (`0001:276`), so an id can never become a name. (b) The obvious fix — point at `people` — collides with the **read-scope asymmetry**: `contracts` is org-union readable (`0003`) but `people` is tenant-member-only (`0001:311`), so an owner name would render for tenant members and silently vanish for exactly the procurement-org and paying-org readers the `0003` union exists to serve. (c) Closing (b) means org-scoping `people`, which **RISK-002 explicitly gates** ("`people` + `identity_accounts` intentionally NOT org-scoped"). The first revision of this document treated (b) and (c) as absent. |
| **Decision** | **DECISION REQUIRED.** No schema may be written. The *shape* that survives review is still "two references with different jobs" (`owner_user_id` as the authority/notification hook; a person reference for the displayed name) — but it cannot be frozen until the three blockers below are answered, because two of them change what the column means and one changes who may see it. |
| **Blocking requirements (must be resolved before any migration)** | **B1-a · write path.** `owner_user_id` has no writer. Either extend `ContractWriteInput` + `parseContractWriteInput` (a contract-write-path change, with its own authority question) or state that owner is set by another mechanism. Until then "keep `owner_user_id` as the authority hook" describes a column nothing can populate. **B1-b · read model.** A person reference needs a read path that serves *every* reader authorized to read the contract, or an explicit, documented decision that org-scoped readers see "Assigned" instead of a name — the `orgDisplayName` degradation pattern already in `src/lib/data/organization-display.ts`. **B1-c · RISK-002.** If the answer to B1-b is "org-scope `people`", that is a RISK-002 change requiring org-scoped read policies **and tests**, not a side effect of a contracts migration. |
| **Rejected (still valid)** | *Widen `profiles` RLS to tenant members* — a T3 trust-boundary change whose blast radius is the whole product, bought for one label. *Free text* — unjoinable; `renewal_responsibility` already demonstrates the failure mode. |
| **Rationale** | Reopened because the earlier decision asserted a capability the source does not support: a write-side relationship was called settled on the strength of a column existing. It also proposed a `people` read that the risk register has deliberately deferred. |
| **Cardinality** | *Provisional, not frozen:* contract **N:1** person, one owner per contract. Co-ownership deferred (see Open). |
| **Lifecycle** | *Provisional:* `people.employee_status` exists, so an inactive owner should raise "no effective owner" rather than cascade-nulling — a departure does not un-own the past. Cannot be frozen while B1-b is open, because a lifecycle rule the org-scoped reader cannot observe is not a product rule. |
| **Tenancy** | **The blocker.** Same-tenant composite FK per `0005` is necessary but not sufficient. The asymmetry in §0's tenth row is the live question, and ownership must **not** grant contract read under any resolution. |
| **Migration** | **BLOCKED** on B1-a/b/c. |
| **UI** | *Provisional:* Detail → *Who owns and who pays*; "No owner assigned" as an attention chip that is also the repair affordance. `hasOwner` remains the only element shippable today. |
| **Open** | B1-a, B1-b, B1-c. Also co-ownership (business vs technical owner) — `apps` already has both (`business_owner_user_id`, `technical_owner_user_id`); deferred until a customer asks. |

## 2. Procurement owner — org anchor **CURRENT** · person reference **DECISION REQUIRED** *(partially reopened)*

| | |
|---|---|
| **Current** | `contracts.procurement_org_id → organizations` is **fully supported on all five layers** — storage (`0001`), write path (`ContractWriteInput.procurementOrgId`), read path, UI, and settled authority. It is doing **two jobs**: "who negotiated this" *and* "who may write to it" (`0002:170`, split into INSERT/UPDATE by `0004:86–91`: an org manager of `procurement_org_id` may write; there is no DELETE policy). |
| **Problem** | The individual category manager who ran the negotiation has nowhere to live, and the obvious move — reuse the org field — would further overload a column that is load-bearing for **write authority**. |
| **Decision** | **Split.** (a) **FROZEN:** `procurement_org_id` stays the write-authority anchor, unchanged — this half is fully supported today and needs no migration. (b) **DECISION REQUIRED:** `procured_by_person_id → people` inherits §1's read-scope asymmetry in full and may not be frozen ahead of it. |
| **Blocking requirement for (b)** | The same B1-b/B1-c as §1: a person reference displayed on an org-union-readable contract has no read path for org-scoped readers, and creating one is a RISK-002 decision. **(b) must be decided together with §1, not separately** — two person references resolved by different rules would be worse than either. |
| **Rejected** | *Derive the procurer from the audit log* — `0010` records the actor of the last write, which is whoever edited a field, not who negotiated the deal. *Reuse `owner_person_id`* — they are genuinely different people (§1 vs a category manager); the prototype fixture had them differ on 6 of 15 contracts. |
| **Rationale** | Separating authority from attribution is the same discipline `0002`/`0004` already apply to `paying_org_id` (read, never write). A descriptive field must never silently become an authority field. The org half survives review because all five layers hold; the person half does not. |
| **Cardinality** | Contract **N:1** organization (existing, frozen). Contract **N:1** person, nullable (*provisional*). |
| **Lifecycle** | Historical. A procurer who leaves stays recorded — a fact about a past negotiation, not a live responsibility, so **no** attention flag on departure (unlike §1). |
| **Tenancy** | Org half: unchanged and settled. Person half: as §1 — the blocker. Being named as procurer grants **nothing** under any resolution. |
| **Migration** | Org half: **none needed**. Person half: **BLOCKED** with §1. |
| **UI** | Detail → *Who owns and who pays*, visually subordinate to the owner. Never in the list. |
| **Open** | The person half, tied to §1's B1-b/B1-c. |

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

## 6. Allocation / chargeback — level **DECIDED VNEXT** · basis vocabulary **DECISION REQUIRED** *(partially reopened)*

| | |
|---|---|
| **Current** | **Nothing.** No table, no percentage, no basis. `docs/v3-data-model.md` notes `invoices` as the eventual chargeback carrier, but invoices are default-deny and out of scope (RISK-002). |
| **Problem** | Three independent axes get conflated whenever anyone sketches this: **level** (whole contract vs a purchased line), **basis** (what kind of number 38% even is), and **time** (§7). Deciding them together produces a table nobody can validate. |
| **Decision** | **Split.** (a) **FROZEN:** allocation is **contract-level** first, effective-dated (§7), with the basis stored explicitly rather than inferred; entitlement-level allocation is **DEFERRED** (§21). (b) **DECISION REQUIRED:** the basis *vocabulary* — because two of the four proposed values collapse concepts that do not exist at contract level. |
| **B3 — the collapse review found** | `by_quantity` and `by_headcount` were listed as contract-level bases, but **neither has a contract-level referent**. Quantities live on `contract_entitlements` (`0084`), one per purchased line, each with its own `quantity_unit`; a contract with two lines in different units has no single "quantity" to allocate by, and three of fifteen fixture contracts have **no lines at all**. Headcount exists nowhere in the schema — `people` rows are not org-attributed for this purpose, and `organizations` carries no headcount. So `basis = 'by_quantity'` on a contract-level row is a pointer to a fact that is either ambiguous or absent, which is precisely the "silently collapse two different domain concepts because the schema lacks one" failure. |
| **Blocking requirements** | **B3-a.** Either restrict the v1 vocabulary to the two bases that *are* computable at contract level (`percentage`, `fixed_amount`) and defer the rest, **or** define what `by_quantity` resolves to when a contract has zero, one, or many entitlement lines in differing units — which is really a decision to make allocation entitlement-level (§21) and should be taken as one. **B3-b.** If `by_headcount` survives, name its source; there is none today. |
| **Provisional shape (not frozen)** | `contract_allocations (contract_id, organization_id, tenant_id, basis, value, effective_from, effective_to, note)`. |
| **Rejected** | *Percentages only* — the fixture alone needed four different bases ("assigned seats at the last true-up", "headcount-weighted", "metered DBU consumption", "named client retainers"); a bare 38% with no basis is unauditable. *Derive allocation from discovered accounts* — that is an access fact, not a commercial agreement, and the split is frequently negotiated against something else entirely. *Store only a computed amount* — loses the rule, so it cannot be re-based next quarter. |
| **Rationale** | Every money figure must name the arithmetic that produced it — the rule the commercial engine already enforces for opportunity estimates. Storing the basis is what makes an allocation checkable by the agency being charged. |
| **Cardinality** | Contract **1:N** allocation rows; each row **N:1** organization. Within an effective period, `percentage` rows must sum to 100. |
| **Lifecycle** | See §7. Historical periods are immutable. |
| **Tenancy** | Follows the contract; adds no read path. An organization must **not** gain contract read by being allocated a share — same rule as §4, and for the same reason. |
| **Migration** | **BLOCKED** on B3-a/B3-b — the basis vocabulary is part of the table's CHECK constraint, so the table cannot be written before the vocabulary is settled. Also still to decide: where sum-to-100 is validated (DB constraint vs application check; a deferrable cross-row constraint is awkward and a partial split mid-edit is legitimate). |
| **UI** | Detail → *Money*: one compact stacked bar + legend with each organization's share **and its cash equivalent**. Absent: "No split agreed", never an implied 100% to the payer. |
| **Open** | B3-a (basis vocabulary), B3-b (`by_headcount` source). Where sum-to-100 is enforced. Whether a `fixed_amount` split may under-allocate deliberately (an unallocated remainder carried centrally) — assumed **yes**, and the remainder must be shown, not hidden. |

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

## 11. Field-level provenance — **DECISION REQUIRED** *(reopened by review; was DECIDED VNEXT)*

| | |
|---|---|
| **Current** | Entitlements have *part* of the pattern: `contract_entitlements.source` (5 bounded values), `.confidence`, `.evidence_file_id`, `.evidence_note` (`0084`). But the DAL **deliberately drops the file id** — `contract-entitlements.ts:24,60` converts `evidence_file_id` to `hasEvidenceDocument: boolean`, explicitly "matching how `owner_user_id`" is handled. So even at line level there is **no read path from a fact to its document**. The contract header has none of it. `audit_logs` records `contract.created`/`.updated` on a curated allowlist with `before_json` deliberately NULL (`0010:36–80`). |
| **Problem** | The first revision froze a table whose **read contract cannot be built today**, for two independent reasons. (a) The intended interaction is "click a source chip → open that document", but the only existing evidence pattern refuses to emit a file id, and that refusal is a deliberate DAL convention rather than an oversight. (b) **`files` is tenant-member-read-only** (`0013:53–54`) while `contracts` is org-union readable (`0003`) — so for a procurement-org or paying-org reader a provenance chip would point at a document they cannot open. A provenance model whose evidence is invisible to a third of its authorized readers is not a model, it is a broken link. |
| **Decision** | **DECISION REQUIRED.** The *shape* still stands — a separate `contract_field_provenance` table, with `audit_logs` untouched — but lifecycle, cardinality and the read contract cannot be frozen until (a) and (b) are answered. |
| **Blocking requirements** | **B2-a · file-id exposure.** Does provenance emit a raw `source_file_id` (reversing the established convention), or an opaque handle, or only a boolean plus a document name? This decides whether the source chip can exist at all. **B2-b · reader parity.** Either org-scope `files` (a RISK-002 change with policies **and** tests) or specify the documented degradation for org-scoped readers — provenance present, evidence unopenable — and confirm that is acceptable product behaviour. **B2-c · cardinality.** "At most one current row per `field_name`" was asserted, not derived; whether two documents may evidence the same field concurrently (an order form and an amendment both stating a quantity during an overlap) has to be decided, because it determines whether the table needs a uniqueness constraint or an effective-dated shape like §7's. |
| **Rejected (still valid)** | *Widen the `0010` audit allowlist* — reverses a deliberate security decision and puts legal text in a table read by different eyes for different reasons. *Columns on `contracts` (`renewal_date_source_file_id`, …)* — one pair of columns per field, forever. *A JSONB blob* — unqueryable, unconstrained, no FK to the evidence file. |
| **Rationale** | Reopened because the read contract is the substance of this feature, not a detail of it. Provenance that cannot be followed to a document is a confidence badge, which is a different and much weaker product. |
| **Cardinality** | **Unresolved — B2-c.** |
| **Lifecycle** | *Provisional:* a provenance row survives the value changing; superseding evidence (§10) adds a row rather than deleting one. Cannot be frozen while B2-c is open, since "adds a row" and "at most one current row" are in tension. |
| **Tenancy** | **The blocker (B2-b).** Same-tenant composite FKs to `contracts` and `files` are necessary but do not address the asymmetry. Under every resolution, provenance must grant **no** read of a file the caller could not already read. |
| **Migration** | **BLOCKED** on B2-a/b/c. |
| **UI** | *Provisional:* a source chip beside a value opening an evidence panel; **"no source recorded"** wherever provenance is absent. Note that "no source recorded" is shippable **now** and is independent of the blockers. |
| **Open** | B2-a, B2-b, B2-c. Also whether provenance is permitted for a manual edit (a human typing a date from an email) — assumed yes with `source = manual_entry` and no file, mirroring `contract_entitlements.source`. |

## 12. Verification / confidence — **DECIDED VNEXT**, but **blocked by §11** (AI generation itself **DEFERRED**)

> **Dependency added by review.** These columns live *on* §11's table. The separation decided here
> (confidence and verification as two columns, canonical value never stored here) is sound and
> unchanged — but it **cannot be implemented before §11's B2-a/b/c resolve**, because §11 no longer
> has a frozen shape to carry them. `verified_by` additionally inherits §1's person-reference
> question. Frozen as a *principle*; blocked as a *migration*.

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

## 15. Recurring amount — **DECISION REQUIRED** *(reopened by review; was DECIDED VNEXT)*

| | |
|---|---|
| **Current** | Not represented distinctly; conflated into `total_cost`. Critically: **`contracts.billing_frequency` has no CHECK constraint** — it is unbounded nullable free text. The only bounded cadence vocabulary in the schema is on the *line* table (`contract_entitlements_billing_frequency_chk`, `0084:123`). The commercial engine's `PERIODS_PER_YEAR` covers exactly three values (`monthly`, `quarterly`, `annual`). |
| **Problem** | The first revision stated a derivation — "normalize `total_cost` to `billing_frequency`" — that **the source cannot support at contract level**. `billing_frequency` may hold any string; a derivation over an unbounded column either silently drops rows it cannot parse or invents a period. That is product preference presented as canonical truth, which is exactly what this document must not do. |
| **Decision** | **DECISION REQUIRED.** Recurring amount stays **derived, never stored** — that half is not in dispute. What cannot be frozen is the derivation's input domain. |
| **Blocking requirement** | **B4 · bound the contract-level cadence, or scope the derivation.** Either (a) add a CHECK to `contracts.billing_frequency` mirroring the line-level vocabulary — which requires the same survey-existing-values step as §3 and §8, and is a data question — or (b) define the derivation as *partial by construction*: it yields a figure only for the three `PERIODS_PER_YEAR` cadences and returns the honest refusal sentence for everything else, including unrecognised free text. **(b) is shippable without a migration** and is the likely answer; it is written here as a decision to take, not one already taken. |
| **Rejected (still valid)** | *A `recurring_amount` column* — a third money column, same drift argument as §14. |
| **Rationale** | Reopened because the derivation was asserted against a column with no vocabulary. The distinction matters: under (b) the product must be explicit that a contract with `billing_frequency = 'Annual (in advance)'` gets no recurring figure — a real fixture-shaped value that the three-value table does not match. |
| **Cardinality** | Derived. |
| **Lifecycle** | n/a. |
| **Tenancy** | None. |
| **Migration** | **None under (b); one CHECK under (a).** Blocked on B4. |
| **UI** | *Money*, shown only where derivable; the refusal sentence otherwise. |
| **Open** | B4. Note this is the same unbounded-vocabulary problem as §3 (`organizations.type`) and §8 (`files.document_type`) — three instances of one pattern, and they should be decided with one rule rather than three. |

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
| **Open** | Whether an FX source is ever introduced. **DEFERRED** — out of scope, and until it exists no surface may combine currencies. **Dependency:** the derivation is only as trustworthy as §13's basis, whose backfill is `DECISION REQUIRED`; until that resolves, annualized value is derivable for *new* correctly-based rows and refuses for legacy ones. |

## 17. Renewal owner — **DECISION REQUIRED** *(reopened by review; was DECIDED VNEXT)*

| | |
|---|---|
| **Current** | `contracts.renewal_responsibility text default 'unknown'` — **free text, not a person reference**. Across the five layers: storage ✅, write path ⚠️ **writable but not clearable** (`contract-write.ts:178–179` assigns the column only when the trimmed value is non-null, so an existing value cannot be blanked back through the form), read ✅, UI ✅, authority ✅ (the contract-write rule). The fixture values are real-shaped ("Global Procurement — software category team", "EMEA procurement, with Global Procurement sign-off above EUR 500k"). |
| **Problem** | Free text cannot be assigned, notified, filtered, or held accountable — but it carries nuance a bare FK would destroy. The first revision resolved this as "both", which is still the right *shape*; what review found is that the FK half is a **third** person reference inheriting §1's unresolved read-scope asymmetry, and that the free-text half has a small write-path defect nobody had recorded. |
| **Decision** | **DECISION REQUIRED**, for the person-reference half only. The free-text half is **CURRENT** and stays. No renewal-owner FK may be specified before §1 resolves, because §1, §2(b) and §17 must share one answer to "how does a person become readable on a contract". |
| **Blocking requirement** | §1's B1-b and B1-c. Additionally: whether `renewal_responsibility` should become clearable is a **write-path** question for the contract form; recorded here so it is not lost, but it is not a domain decision and does not block. |
| **Rejected** | *Replace the free text with an FK* — loses "with Global Procurement sign-off above EUR 500k", which is the kind of thing that decides whether a renewal is actually approved. *Reuse the contract owner* — they differ; a contract owned by Flywheel RevOps can have a renewal run by Global Procurement. |
| **Rationale** | A structured assignee and an unstructured policy note answer different questions. But three person references (§1, §2b, §17) resolved by three different rules is exactly the incoherence this document exists to prevent. |
| **Cardinality** | *Provisional:* renewal cycle **N:1** person. |
| **Lifecycle** | *Provisional:* per **cycle** — the renewal owner may change between cycles, and that history is worth keeping. |
| **Tenancy** | As §1 — the blocker. |
| **Migration** | **BLOCKED** with §1. `renewal_responsibility` itself is **unchanged** and needs no migration. |
| **UI** | Detail → *Time* / renewal panel. The free-text arrangement is shippable today; the named assignee is not. |
| **Open** | Tied to §1 B1-b/B1-c. Separately: should `renewal_responsibility` be clearable? |

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
| **Open** | Whether cycles are **generated** in advance (a row per anticipated renewal) or created on first interaction. Assumed: **on first interaction**, so the table holds decisions rather than speculation. **Dependencies added by review:** two of this table's proposed columns are blocked elsewhere — `owner_person_id` by §17, `vendor_quote_id` by §19. The cycle's own decisions (per-cycle granularity, derived notice deadline, state machine, no task system) are unaffected and stay frozen; the table can be built without those two columns and gain them later. |

## 19. Vendor renewal quote — separation **DECIDED VNEXT** · shape **DECISION REQUIRED** *(partially reopened)*

| | |
|---|---|
| **Current** | **Nothing.** In the fixture the Adobe FY27 quote (EUR 703,000, +14.8%) exists only as an attached PDF with no structure — while being the most decision-relevant number on the screen. |
| **Problem** | The obvious shortcut — put the quote in `total_cost` — would overwrite a **commitment** with a **proposal**. |
| **Decision** | **Split.** (a) **FROZEN:** a quote is a distinct object and **`total_cost` is never touched by one**; an accepted quote becomes a contract amendment through the normal write path. This separation is the load-bearing decision and it survives review. (b) **DECISION REQUIRED:** the concrete shape, for two reasons below. |
| **B3 — the two dependencies review found** | **B3-c · `quoted_basis` depends on an unresolved decision.** It was specified as "reuses §13's vocabulary", but §13's backfill is itself `DECISION REQUIRED`; a quote's basis cannot be frozen against a vocabulary whose meaning for existing data is undecided. A quote *is* the cleaner case (it is always new data, never backfilled), so this may resolve quickly — but it must resolve, not be assumed. **B3-d · `source_file_id` inherits §11's asymmetry.** `files` is tenant-member-read-only (`0013:53–54`) while quotes hang off org-union-readable contracts, so a quote's evidence is invisible to org-scoped readers — the same B2-b hole, and it must get the same answer. |
| **Rejected (still valid)** | *Overload `total_cost`* — destroys the record of what we are actually committed to. *A note field* — unqueryable; renewal exposure cannot see it. *Model it as a `files` row only* — a document is evidence, not a structured claim. |
| **Rationale** | A quote is a **proposal by a counterparty** — structurally the same kind of thing as an AI extraction: a claim with a source and a status, not a fact about our commitment. That framing is frozen. What is not frozen is a shape that quietly depends on two open decisions. |
| **Cardinality** | *Provisional:* contract **1:N** quotes (renegotiation produces several); a renewal cycle references **at most one** current quote. |
| **Lifecycle** | *Provisional:* `valid_until` makes expiry explicit rather than inferred; a rejected quote is retained as negotiation history. |
| **Tenancy** | Follows the contract. `source_file_id` composite-FK'd same-tenant — necessary, but see B3-d. |
| **Migration** | **BLOCKED** on B3-c and B3-d. Provisional shape: `vendor_quotes (contract_id, tenant_id, quoted_amount, currency, quoted_basis, quote_date, valid_until, source_file_id, status, note)`, `status` ∈ `received` · `under_review` · `accepted` · `rejected` · `expired`. |
| **UI** | *Money* → "Vendor position": the proposed figure, the delta against the recorded value, the status, and its source document. Never merged into the committed figure. |
| **Open** | B3-c (`quoted_basis` depends on §13), B3-d (`source_file_id` inherits §11's B2-b). Whether a quote can exist without a contract (a proposal for something not yet bought) stays **DEFERRED** — a pre-contract proposal is a draft contract, which the model already supports via `status = 'Draft'`. |

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

> **Revised after independent review (2026-09-05).** The first revision froze decisions resting on
> capability the source does not support — chiefly the read-scope asymmetry in §0's tenth row, and a
> write path for `owner_user_id` that **does not exist**. Counts below are derived from this
> document, not asserted: **21 topics · 17 frozen entries · 18 open questions across 11 topics ·
> 10 of 21 topics now carry a `DECISION REQUIRED`** (§§1, 2, 4, 6, 11, 13, 15, 17, 19, 20), up from
> 3 in the reviewed revision. Several topics are split, so a topic number can appear in both tables —
> once for its frozen half, once for its blocked half.

### Frozen — implementation may proceed once the pre-work below clears

| # | Decision |
|---|---|
| 2a | `procurement_org_id` stays the write anchor, unchanged — the only ownership field supported on all five layers |
| 3 | Paying-org relationship unchanged; `organizations.type` gains a bounded CHECK |
| 4a | `contract_beneficiaries` join table on the **contract** (tenancy question still open) |
| 5 | `relationship_type` surfaced + bounded; entitlement refs stay the precise join; `contracts.vendor_id` added |
| 6a | Allocation is **contract-level**, effective-dated, with the basis stored rather than inferred |
| 7 | Allocations are **effective-dated**; re-basing closes and inserts; closed periods immutable |
| 8 | `files.document_type` bounded to eight values and surfaced |
| 9 | `files.effective_date` added; "terms in force" is **derived**, never stored |
| 10 | Supersession is a **DAG** via `supersedes_file_id` (single-parent assumption flagged) |
| 12 | `extraction_confidence` and `verification_state` kept as **separate** columns; canonical value never stored there — *principle frozen, migration blocked by §11* |
| 13a | `total_cost_basis` + `term_months` as the **shape**; `total_cost` never overwritten |
| 14 | Committed term value is **derived**; no column |
| 16 | Annualized value is **derived**; never summed across currencies |
| 17a | `renewal_responsibility` retained as free text alongside any future assignee |
| 18 | `contract_renewals` **per cycle**; notice deadline becomes derived; no task system |
| 19a | A quote is a distinct object; **`total_cost` is never overloaded** by one |
| 21 | Placement rule: varies by product ⇒ line; property of the agreement ⇒ contract |

### Blocked — no schema may be written until answered

Three classes, deliberately distinguished. **(P) product/ownership call** — blocks the decision
itself. **(T) tenancy/read-model call** — blocks because it changes who can see the result, and is a
security decision rather than a product one. **(I) implementation call inside a frozen decision** —
the shape is settled; how to express or enforce one part is not.

| # | Ref | Open question | Blocks | Class | Owner |
|---|---|---|---|---|---|
| 1 | B1-a | **`owner_user_id` has no write path** — no `owner*` key in `ContractWriteInput`; nothing in the product can set an owner. Extend the write path, or state how owner is set. | the whole owner model | P | Sam + implementer |
| 1 | B1-b | **Read-model parity for a person reference.** `contracts` is org-union readable; `people` is tenant-member only. Serve every authorized reader, or document the degradation. | §1, §2b, §17 | T | Sam + security review |
| 1 | B1-c | If B1-b resolves to "org-scope `people`", that is a **RISK-002** change needing policies **and** tests — not a side effect of a contracts migration. | §1, §2b, §17 | T | security review |
| 4 | — | **Does beneficiary membership grant contract READ?** Changes the `0003` union. Planning default: **no**. | `contract_beneficiaries` | T | Sam + security review |
| 6 | B3-a | **`by_quantity` has no contract-level referent** — quantities are per line, in differing units, and three fixture contracts have none. Restrict the v1 vocabulary, or make allocation entitlement-level. | allocation CHECK | P | Sam |
| 6 | B3-b | **`by_headcount` has no source** anywhere in the schema. | allocation CHECK | P | Sam |
| 6 | — | Where is sum-to-100 enforced (DB constraint vs application)? | allocation migration | I | implementer + DB reviewer |
| 10 | — | May one document supersede **several**? Changes self-FK → edge table. | supersession migration | I | Sam |
| 11 | B2-a | **Does provenance emit a raw `source_file_id`?** The entitlement DAL deliberately converts it to a boolean; the source chip cannot exist without reversing that convention. | provenance read contract | P | Sam + security review |
| 11 | B2-b | **`files` is tenant-member-read-only** while contracts are org-union readable — evidence is unopenable for org-scoped readers. | provenance + §19 evidence | T | Sam + security review |
| 11 | B2-c | **Cardinality is unproven** — may two documents evidence one field concurrently? Decides uniqueness vs effective dating. | provenance table shape | I | Sam |
| 13 | — | **What do existing `total_cost` rows mean?** A data decision, possibly per contract. Cannot be inferred. | `total_cost_basis` NOT NULL, every annualized figure | P | Sam / Tim |
| 15 | B4 | **`contracts.billing_frequency` has no CHECK** — the derivation was asserted over an unbounded column. Bound it, or scope the derivation to the three known cadences and refuse the rest. | recurring-amount derivation | P | Sam |
| 17 | — | Should `renewal_responsibility` become clearable? (`contract-write.ts:178–179` only sets it when non-null.) Write-path defect, non-blocking. | contract form | I | implementer |
| 19 | B3-c | `quoted_basis` was specified as reusing §13's vocabulary, which is itself unresolved. | `vendor_quotes` | P | Sam / Tim |
| 19 | B3-d | `source_file_id` inherits B2-b. | `vendor_quotes` | T | with B2-b |
| 20 | — | **Negotiation target: enum, free text, or both — and who may read it**, given paying-org read. | `target_outcome` on §18 | P + T | Sam / Tim |
| 12 | — | Does `verified_by` name a person, or render as an unattributed "verified"? | provenance columns | T | Sam (privacy posture) |

**The three pre-existing blockers survive this revision unchanged and unresolved:** §4 tenancy, §13
backfill, §20. None was answered here, and none may be answered without evidence.

**One answer settles five rows.** B1-b, B1-c, B2-b, B3-d and §12's `verified_by` are all the same
question — *how does a fact stored on an org-union-readable contract become visible to org-scoped
readers when its referent lives in a tenant-member-only table?* They should be taken as one decision,
not five.

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
