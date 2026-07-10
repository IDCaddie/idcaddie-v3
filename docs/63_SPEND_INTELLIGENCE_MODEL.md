# 63 — Spend Intelligence Model (M-001, design-only)

> **CURRENT CURSOR (2026-07-08):** `idcaddie-v3` main @ `e0e8fd0` (PRs through **#287**); `idcaddie-connector-runner`
> main @ `84ecf6d` (untouched). Governance (current, 2026-07-10): **RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as a governance state only (C-2c staging live sync completed 2026-07-10 (staging-only; production untouched; connector-runner PR #36)); connector live
> data-sync has not run; production untouched.**
>
> **THIS IS A DESIGN DOCUMENT ONLY.** No schema, tables, migrations, imports, finance connectors, or UI exist or are
> created by this PR. Everything below labelled a "table", "field", or "phase" is a **proposal** to be reviewed later,
> not a shipped artifact. Old-app parity is **NOT** complete.

**Purpose.** Translate Lunch Money-style personal-finance mechanics (recurring-item detection, learn-from-corrections
rules, a review inbox, source health) into ID Caddie's **enterprise SaaS-governance** model — tenants, org ownership,
app inventory, contracts, licenses, RLS, audit, and gated connectors.

---

## 1. Executive summary

ID Caddie's job is to answer "what SaaS are we paying for, who owns it, which contract governs it, and is any of it
wasted?" Today v3 shows **contract totals** (a commitment number), not **observed spend** (what actually hit the card /
invoice). To close that gap without repeating the old app's mistakes, v3 needs a **spend intelligence layer**.

**Core thesis:** *Do not build SaaS spend intelligence on raw invoice/card rows. Build durable subscription/license
anchors, normalized spend events, attribution rules, review states, and source health **first**.* Raw rows are noisy,
duplicated, multi-currency, and messily-named; a report built directly on them inherits all of that. The durable layer
(anchors + normalized events + reviewed attribution) is what makes reports trustworthy.

**Why before reports:** a "spend by app / by org / by contract" report is only as correct as the attribution beneath it.
If reports ship before reviewed subscriptions + attributions exist, every number is a guess presented as fact — exactly
the "read-only surface that looks authoritative but isn't" failure the rest of v3 avoids. **Reports come last (S8), after
reviewed anchors and attributions (S3–S5).**

**Analogy, not a copy.** Lunch Money is personal finance (one user, their bank, their budget). ID Caddie is multi-tenant
governance (org ownership, RLS per row, contracts, licenses, audit, connector gates). We borrow the *mechanics*
(first-class recurring anchors, rules learned from corrections, a review inbox, source freshness) — never the
implementation or the single-user trust model.

---

## 2. Core pipeline

The durable flow every spend datum travels, source-agnostic:

```
source connection / import
  → import batch (one ingestion run, idempotent)
    → normalized spend/usage event (immutable observed row; source truth preserved)
      → subscription / license anchor (the durable recurring commitment it belongs to)
        → attribution rule (tenant-scoped data that SUGGESTS assignment)
          → admin review / confirm (governance decision; nothing auto-trusted early)
            → spend / license intelligence (drift, waste, coverage, ownership gaps)
  ⟂ source health (freshness + error state feeds /connectors, /needs-attention, /admin)
```

Two invariants: (a) the **observed event is immutable** — attribution/review decisions live *beside* it, never overwrite
it; (b) **suggestion ≠ truth** — a rule proposes, a human (or an explicitly-approved auto-confirm policy) disposes.

---

## 3. Key mechanics translated to ID Caddie

- **Recurring items as first-class anchors.** Lunch Money promotes a repeating charge to a "recurring item." Here that
  becomes a **subscription/license anchor** — a durable tenant/org-scoped object (not a contract, not a raw row) that
  spend events attach to and that powers drift/renewal/coverage checks.
- **Rules learned from admin corrections.** When an admin re-attributes an event ("this 'ATLAS-SUB' charge is Atlassian
  → app Jira → org Eng"), the correction can *suggest* an **attribution rule** for future events — as reviewable data,
  never executable code (§7).
- **Source-agnostic ingestion.** One pipeline for **CSV upload, manual entry, finance API, and (gated) connector** —
  all land as the same normalized event shape. The first supported path is manual/CSV (S3); connectors stay gated.
- **Duplicate identity resolution.** Messy merchant strings, re-imported files, and the same vendor across sources must
  resolve to one vendor/app/subscription — via reviewable matches, reusing the existing app-catalog alias graph
  (`/catalog`, migrations 0024/0026) rather than a new fuzzy black box.
- **Multi-currency normalization.** Every event keeps its original amount+currency and a *separate* base-currency
  rollup (§9); source truth is never overwritten.
- **Connector/source health + freshness.** Every source reports last-success/last-event/error-class so stale or
  broken feeds surface loudly (§10) instead of silently under-reporting spend.
- **Review/confirm governance queue.** A first-class inbox of "needs a human decision" items (§8), mapped into the
  existing `/needs-attention` surface.

---

## 4. Domain definitions

Precise, non-overlapping meanings (these disambiguate the whole model):

- **Contract** — a *legal/commercial document* (the MSA/order form). Already exists in v3 (`contracts`). A contract may
  govern zero or many subscriptions.
- **Subscription** — a *recurring commercial/license commitment* (e.g. "Figma Organization, 40 seats, annual"). New
  concept. Not a contract; not a raw charge. The durable anchor.
- **Spend event** — a single *observed* charge / invoice line / payment / usage row, exactly as ingested. Immutable.
- **Attribution** — the *evolving assignment* of a spend event to a vendor / app / org / contract / subscription. Lives
  beside the event; can change as review improves; is versioned/audited.
- **Rule** — a *tenant-scoped data object* that suggests future attributions from safe operators (§7). Data, not code.
- **Review item** — a *governance task* requiring a human confirm/reject/re-assign decision (§8).

---

## 5. Proposed future tables

**Proposal only — none of these exist.** Each would ship migration-first (RLS enabled + default-deny until a reviewed
SELECT policy) with an RLS test matrix (§14) before any read surface. All carry `tenant_id` + org-ownership columns;
authorization is **Postgres RLS**, never app/client filtering; no service-role on any request path.

### `spend_sources`
- **Purpose:** a configured origin of spend data (manual, CSV upload, finance API, or a gated connector).
- **Key fields (proposed):** `id`, `tenant_id`, `org_id`, `kind` (manual|csv|api|connector), `display_name`, `status`,
  `base_currency_hint`, `created_by`, timestamps.
- **RLS:** tenant-member read; write via a reviewed policy + audited action. **Never stores a credential** — any
  connector secret lives only in the existing KMS-envelope vault (gated), referenced by id, never inlined.
- **Sensitive fields:** none stored here (no tokens/keys/URLs). `created_by` is a raw user id → exposed as a boolean/
  name in DTOs, never rendered raw.
- **UI:** `/connectors` (source health), `/admin` (source list).

### `source_import_batches`
- **Purpose:** one idempotent ingestion run (a CSV upload, an API pull), enabling dedupe + re-run safety.
- **Key fields:** `id`, `tenant_id`, `source_id`, `external_batch_key` (idempotency), `status`, `records_seen`,
  `records_imported`, `records_rejected`, `started_at`, `finished_at`, `error_class`.
- **RLS:** tenant-member read. **Sensitive:** none (counts + safe error class only; never raw payloads).
- **UI:** `/needs-attention` (stale/failed), `/admin`, `/connectors`.

### `source_spend_events`
- **Purpose:** the immutable normalized observed row (charge/invoice line/payment/usage).
- **Key fields:** `id`, `tenant_id`, `source_id`, `batch_id`, `occurred_on`, `merchant_raw`, `description_raw`,
  `original_amount`, `original_currency`, `base_amount`, `base_currency`, `fx_rate_date`, `fx_rate_source`,
  `dedupe_hash`, `created_at`.
- **RLS:** tenant-member read (default-deny until reviewed). **Sensitive:** `merchant_raw`/`description_raw` may contain
  noisy vendor strings — safe to show, but **no raw source payload / no card numbers / no account ids** are stored;
  ingestion strips anything outside the allowed column set. Immutable (no update/delete; corrections are new
  attributions, not row edits).
- **UI:** a future `/spend` review table + drill-downs on `/apps/[id]`, `/contracts/[id]`.

### `spend_event_attributions`
- **Purpose:** the versioned assignment of an event to vendor/app/org/contract/subscription.
- **Key fields:** `id`, `tenant_id`, `event_id`, `vendor_id?`, `app_id?`, `org_id?`, `contract_id?`, `subscription_id?`,
  `method` (rule|manual|import), `rule_id?`, `confidence`, `status` (suggested|confirmed|rejected), `decided_by?`,
  `decided_at?`, `superseded_by?`.
- **RLS:** tenant-member read; write is an audited governance action. **Sensitive:** `decided_by` → boolean/name only.
- **UI:** review queue, event drill-downs.

### `subscriptions`
- **Purpose:** the durable subscription/license anchor (§6).
- **Key fields:** `id`, `tenant_id`, `app_id?`, `vendor_id?`, `contract_id?`, `owning_org_id?`, `owner_present` (bool),
  `sku`, `plan_name`, `cadence` (monthly|annual|…), `seats?`, `expected_amount_min`, `expected_amount_max`,
  `expected_currency`, `renewal_date?`, `status`, timestamps.
- **RLS:** tenant-member + org-scoped read (mirrors `apps`/`contracts` helpers). **Sensitive:** owner as a boolean/org
  name, never a raw user id.
- **UI:** `/apps/[id]` (subscriptions panel), `/contracts/[id]` (coverage), a future `/subscriptions` list, dashboards.

### `subscription_events`
- **Purpose:** the timeline of an anchor (created, amount drift observed, renewal, cadence change) — audit-like.
- **Key fields:** `id`, `tenant_id`, `subscription_id`, `event_type`, `observed_on`, `detail_safe` (structured, no raw
  payload), `source_event_id?`.
- **RLS:** tenant-member read; append-only. **Sensitive:** none (safe structured detail only).
- **UI:** subscription drill-down, drift/renewal alerts.

### `attribution_rules`
- **Purpose:** tenant-scoped data that suggests future attributions (§7) — **data, not code**.
- **Key fields:** `id`, `tenant_id`, `operator` (allowlist), `field`, `value`, `target` (vendor/app/org/contract/
  subscription), `status`, `created_by`, `created_from_event?`, `last_matched_at?`, `match_count`,
  `false_positive_count`, `sample_matched_event_ids`, `explanation`.
- **RLS:** tenant-member read; write audited. **Sensitive:** `created_by` → boolean/name. **No SQL/expression is ever
  stored** — only allowlisted operator + literal value.
- **UI:** review queue ("create rule from this correction"), a rules admin list.

### `spend_review_items`
- **Purpose:** the governance inbox (§8) — one row per decision a human must make.
- **Key fields:** `id`, `tenant_id`, `item_type`, `event_id?`, `subscription_id?`, `suggested_attribution?`, `status`
  (open|confirmed|rejected|ignored), `assigned_org_id?`, `decided_by?`, `decided_at?`.
- **RLS:** tenant-member + org-scoped read; decisions are audited writes. **Sensitive:** `decided_by` → boolean/name.
- **UI:** `/needs-attention` (primary), a future `/spend/review`.

### `fx_rates`
- **Purpose:** reference FX rates for base-currency rollups (§9), with provenance.
- **Key fields:** `id`, `as_of_date`, `from_currency`, `to_currency`, `rate`, `source`, `created_at`. (Reference data —
  may be tenant-agnostic; if so, read-only to all authenticated users, never writable by them.)
- **RLS:** read-only reference; no tenant write. **Sensitive:** none.
- **UI:** not directly; drives base-amount display + an "as of" stamp.

---

## 6. Subscription anchor design

- **Subscriptions are NOT contracts.** A contract is the legal document; a subscription is the recurring commitment.
  Keeping them separate avoids the old app's conflation of "the paper" with "the spend."
- **A contract can govern many subscriptions** (one MSA → Jira + Confluence + Bitbucket subscriptions).
- **An app can have many subscriptions** (Figma: a design-team annual seat plan + a dev-team monthly plan).
- **A subscription connects** apps, vendors, contracts, orgs, owners, SKUs, renewal dates, expected amount ranges, and
  cadence — the join that makes spend answerable by any of those axes.
- **What anchors power:** *drift detection* (observed base_amount outside `expected_amount_min…max`), *renewal alerts*
  (approaching `renewal_date` with no covering contract), *contract coverage* (subscriptions with no `contract_id`),
  and *ownership gaps* (`owner_present = false` or no `owning_org_id`). These reuse the existing attention/Needs-Attention
  pattern rather than a new alerting engine.

---

## 7. Attribution rules design

**Rules are data, not code.** A rule is `{operator, field, value, target}` — evaluated by a fixed, reviewed matcher,
never by executing user input.

- **Allowed initial operators:** `equals`, `contains`, `starts_with`, `amount_between`, `currency_equals`,
  `source_equals`.
- **Forbidden initially (hard):** arbitrary SQL, `eval`, JavaScript expressions, user-supplied SQL fragments, unbounded
  regex, and any template interpolation into SQL. (These are the injection/DoS surfaces; excluded by construction.)
- **A rule tracks:** `created_by`, `created_from_event`, `last_matched_at`, `match_count`, `false_positive_count`,
  `status`, `sample_matched_event_ids`, and a human-readable `explanation`. False-positive count + samples let admins
  see a rule's real behavior before trusting it.
- **Default posture:** a rule **suggests**; it does not auto-apply (auto-confirm is an explicit, per-tenant, later
  decision — see Open Questions). `amount_between` uses base or original amount explicitly (never ambiguous).

---

## 8. Review queue design

A first-class governance inbox, surfaced through `/needs-attention`.

- **Item types:** unreviewed spend event · suggested attribution · unmatched vendor · unmatched app · missing
  subscription anchor · missing owner/org · missing contract · possible duplicate subscription · unexpected amount
  change · stale source.
- **Actions:** confirm · reject · change app · change subscription · change org · create/update rule · ignore once ·
  mark duplicate.
- Every action is an **audited write** (reuses the append-only audit trigger pattern); "ignore once" is scoped to the
  single item so it never silently suppresses a class of problems.

---

## 9. Multi-currency model

- **Store both, overwrite neither:** `original_amount`, `original_currency` (source truth, immutable) **and**
  `base_amount`, `base_currency`, `fx_rate_date`, `fx_rate_source` (derived rollup).
- **Reports roll up on base currency; drill-downs always show the original amount** + the FX rate + "as of" date, so a
  number is never silently converted without provenance.
- FX is reference data (`fx_rates`) with a source + date; a missing rate is a **review item**, not a silent zero.

---

## 10. Source health model

Each `spend_sources` row (and its latest batch) reports:
- `status` · `last_attempt_at` · `last_success_at` · `last_event_at` · `last_error_class` (safe class, never a raw
  provider error/token) · `records_seen` · `records_imported` · `records_rejected` · `needs_reauth` (bool).

**Surfaces:** `/connectors` (per-source health, matching the existing safe-metadata pattern), `/dashboards` (a "stale
sources" tile), `/needs-attention` (stale/failed/needs-reauth items), `/admin` (source inventory). A stale or broken
source must read *loudly* — silent under-reporting of spend is the failure mode to prevent.

---

## 11. Failure modes and defenses

| Failure mode | Defense |
|---|---|
| Duplicate imports (same CSV twice) | `external_batch_key` idempotency + per-event `dedupe_hash`; re-run is a no-op |
| Duplicate vendors/apps/subscriptions | reviewable identity resolution via the app-catalog alias graph; "possible duplicate" review item |
| Orphaned events (no anchor) | "missing subscription anchor" review item; events never silently dropped |
| Stale syncs | source health surfaces (§10); freshness thresholds → Needs-Attention |
| Messy merchant names | keep `merchant_raw`; normalize via reviewed rules/aliases, never a silent fuzzy overwrite |
| Rules misfiring | `false_positive_count` + `sample_matched_event_ids`; suggest-not-apply default; rules disableable |
| Multi-currency errors | store original + base separately; missing FX = review item; provenance shown |
| Over-automation | human review is the default; auto-confirm is an explicit, audited, per-tenant opt-in only |

---

## 12. Build order

- **M-001 — design doc only (THIS doc).** No schema, no code.
- **S1 — schema / RLS proposal.** Draft tables + RLS policies + the RLS test matrix (§14). Docs/review only.
- **S2 — migration-gated foundation.** Reviewed migrations adding the tables **RLS-enabled + default-deny**, user-scoped
  DALs, RLS tests; staging-apply only, **no production apply**. No UI yet.
- **S3 — manual / CSV import first.** The simplest, most controllable source (no connector) → normalized events.
- **S4 — subscription anchors.** Create/confirm anchors; attach events.
- **S5 — rules from corrections.** Suggest attribution rules from admin re-assignments (data-only operators).
- **S6 — multi-currency.** `fx_rates` + base rollups + provenance display.
- **S7 — source health / freshness.** Health model + surfaces.
- **S8 — reports.** Spend-by-app/org/contract, drift, waste — **built on reviewed subscriptions + attributions.**

> **Explicit sequencing rule:** **reports (S8) come AFTER reviewed subscriptions/attributions (S3–S5), not before.** A
> report on unreviewed raw events would present guesses as facts.

---

## 13. Non-goals for this PR

This PR **does not**: add migrations · add tables · add imports · add finance connectors · change connector-runner ·
run live sync · change RISK-007 · unblock Phase C · touch production · read secrets/tokens · implement UI. It is a
design document only; every "table"/"field"/"phase" above is a proposal for later review.

---

## 14. Open questions

- Should subscriptions be **app-scoped, vendor-scoped, or both**? (Leaning both, with app_id + vendor_id optional and at
  least one required.)
- Should **base currency be tenant-level** (one per tenant) or configurable per org/source?
- What is the **first CSV format** to support (columns, date/amount/currency conventions, header contract)?
- Should **rule auto-confirm** ever be allowed — and if so, behind what per-tenant governance + confidence threshold?
- How should **invoices later attach to subscriptions** (invoice line → spend event → subscription), and how does that
  reconcile with the separately-gated `invoices` table?
- How does this interact with **existing contracts and the app catalog** (reuse `app_contracts`, alias graph 0024/0026)?
- What **RLS test matrix** is required before any migration (per-table: tenant isolation, org scoping, default-deny,
  no-service-role, append-only where claimed, cross-tenant reject)?
- How should **review queues map to Needs Attention** (item-type → section, dedupe, and "ignore once" scoping)?

---

*Design-only. No schema, tables, migrations, imports, connectors, or UI exist or are created here. Governance (current,
2026-07-10): RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as a governance state only (C-2c
has NOT started — separate per-run Sam GO + clean Phase-2c readiness run required); connector live data-sync has not
run; production untouched; old-app parity is NOT complete.*
