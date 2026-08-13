# 84 — Contract & Entitlement Intelligence

> **Cursor (2026-08-12):** `idcaddie-v3` main @ `784a632` (PRs through **#405**). Branch
> `phase10/contract-entitlement-intelligence`. Migration **0083** is the first artifact; staging apply pending.
> Parallel workstreams NOT touched by this phase: Slack activation/deployment, the Google Workspace connector,
> connector authentication, OAuth, the connector runner, AWS worker infrastructure, the Okta implementation, and the
> shared connector framework.

## 1. What this phase is

v3 can already state a commitment ("there is a Slack contract worth $180,000") and, separately, an observation ("this
Slack connector holds 3,011 accounts"). It cannot state whether those two agree, because nothing records **what was
bought**. This phase adds the purchased side of the commercial graph and the deterministic reconciliation that sits on
top of it.

The chain this is building toward, in full:

```
contract → vendor → product/SKU → PURCHASED entitlement → discovered assignment → usage → spend → renewal → savings
```

## 2. Audit of what already existed

Performed against `784a632` before any code was written. Nothing below was rebuilt.

### COMPLETE

| Capability | Where |
|---|---|
| Contract record: create / edit / list / detail / CSV export | `src/app/(authenticated)/contracts/**`, `src/lib/data/contracts.ts` |
| Contract write authorization (tenant editor+ **or** procurement-org manager; paying org never writes; no DELETE) | `0004`, `0003` |
| Contract audit-on-write (SECURITY DEFINER trigger, actor = caller) | `0010` |
| Contract source documents (upload, list, storage auth) | `0012`–`0016`, `contract-files.tsx` |
| Renewal facts: `renewal_date`, `end_date`, `notice_deadline`, `auto_renew`, `month_to_month` | `0001`, `0011` |
| Renewal attention flags (30/90-day buckets, missing-date, missing-owner, no-linked-app) | `src/lib/data/contract-attention.ts` |
| Contract ↔ app link | `app_contracts` (`0001`), org-scoped read (`0006`), `src/lib/data/links.ts` |
| Contract-level spend total (sum of `total_cost` by currency) | lineage metric `tracked_spend` |
| Canonical vendor / product / alias tables | `vendors`, `app_products`, `app_aliases` (`0024`, `0026`) |
| Directory-side discovered evidence: identities, groups, applications, assignments, stale-aware counts | `0053`–`0061`, `0070`–`0074` |
| SaaS-side discovered evidence: `app_accounts`, groups, memberships, email-only identity matcher | `0076`–`0078` |
| Access-topology governance findings engine + presenter (severity, confidence, deterministic ids) | `src/lib/server/governance-analytics/**`, `src/lib/data/governance-presenter.ts` |
| Source capability model (SUPPORT × STATE — "unavailable" is never a zero) | `src/lib/canonical/capabilities.ts` |
| Machine-checked metric lineage registry | `src/lib/canonical/lineage.ts` |

### PARTIAL

- **`application_matches` (`0075`)** — the directory-application ↔ `apps` link, with method / confidence / status /
  provenance. Correct shape, **zero rows, no matcher, nothing reads it.**
- **`invoices` (`0001`)** — table exists, default-deny, nothing reads it (RISK-002).
- **`vendors` / `app_products`** — canonical rows exist, but `contracts.vendor_name` and `apps.vendor_name` are **free
  text with no foreign key to them**, so a canonical vendor was unreachable from a contract.

### DESIGN-ONLY

- **`docs/63_SPEND_INTELLIGENCE_MODEL.md`** — proposes `spend_sources`, `source_import_batches`, `source_spend_events`,
  `spend_event_attributions`, `subscriptions`, `subscription_events`, `attribution_rules`, `spend_review_items`,
  `fx_rates`. **None exist.** Its build order (S1–S8) is about ingesting *observed* spend from invoices and card feeds.
  This phase deliberately does **not** start there — see §6.
- **`docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md`** — no extraction code exists. No AI is added here.

### MISSING (before this phase)

Purchased quantity / seats anywhere · unit price · SKU / plan name · contract → canonical vendor link · contract →
canonical product link · any reconciliation of purchased against discovered · provenance or confidence on any financial
field · a billable concept (`license_evaluations` has existed since `0001` and **has never been written by anything**;
there is no rule engine and no billing feed) · usage/activity (the `usage` capability is vocabulary only — no connector
produces it) · savings estimation · commercial findings of any kind.

## 3. The five quantities, kept apart

The single most expensive available mistake is one "seats" number whose meaning is decided later. These are different
facts, with different sources, and the model keeps them separate — permanently.

| Concept | Means | Source today |
|---|---|---|
| **purchased** | what the contract says was bought | `contract_entitlements` (**new**, `0083`) |
| **assigned** | who the identity provider grants access to | `directory_application_user_assignments` (`0059`) |
| **provisioned** | who exists in the vendor's own system | `app_accounts` where `sync_status = 'current'` (`0076`) |
| **billable** | who the vendor actually charges for | **no source exists** |
| **active** | who actually used it | **no source exists** |

Two consequences that are not negotiable:

1. `app_accounts.account_status = 'active'` is the **provider's lifecycle bucket** — an account that exists and is not
   suspended. It is **not usage**. Reporting it as "recently active" would be a claim the evidence does not support.
2. Because billable and active have no source, the reconciliation reports them as **unavailable**, never as `0`. This is
   the Phase-7B rule (`capabilities.ts`) applied to money: a zero is a claim, and an unmeasured quantity is not zero.

## 4. Migration 0083 — `contract_entitlements`

One row = **one purchased line**: this contract bought this much of this product, at this unit price, on this cadence,
for this term.

Design rules encoded in the schema itself, not in a convention document:

- **Unknown is not zero.** Every commercial quantity is nullable. `purchased_quantity IS NULL` means "not recorded".
- **Measurement is declared, never inferred.** `measured_by_connection_id` names the connector whose evidence this line
  is compared against. There is no name or domain matching — "Slack" the contract and a connector with
  `provider='slack'` may be different workspaces, regions, or vendors sharing a word. Same reasoning as connector
  supersession (`0071`) and application matches (`0075`): declare, never infer.
- **A price that cannot be annualized is not a price.** `unit_amount` is CHECK-constrained to require both `currency`
  and `billing_frequency`. The database refuses the half-fact rather than letting an engine assume USD/annual.
- **`minimum_quantity` is a savings brake.** Reclaim below a contracted floor is still paid for. Omitting it would make
  the very first savings finding wrong, not merely incomplete.
- **Provenance is mandatory.** `source` and `confidence` are NOT NULL, defaulting to the conservative reading
  (`manual_entry` / `low`), with `evidence_file_id` pointing at the uploaded document via the existing files model.
- **Authorization is inherited, not reinvented.** Read = the visibility of the parent contract (the `0006` subquery-RLS
  mechanism). Write = the same two authorities that may write the contract (`0004`). No DELETE policy.
- **Audited on write** via the `0010` SECURITY DEFINER trigger pattern. The allowlist records the quantity — the
  audit question this table exists to answer — and deliberately not the price, matching `0010`'s convention.

Verified by `supabase/tests/contract_entitlement_test.sql` (T1–T11): editor write, audited actor, price excluded from
audit metadata, viewer read-not-write, procurement-manager read **and** write, paying-manager read-not-write,
unaffiliated user sees nothing, cross-tenant isolation, no DELETE for anyone, the seven CHECK refusals, cross-tenant FK
refusal on both contract and vendor, and NULL-not-zero with conservative provenance defaults.

## 5. What 0083 deliberately does not add

`discount_percent`, `tier`/pricing-structure, `termination_provisions`, `notice_period_days`, and a
`minimum_commitment_amount` are all real contract facts and all absent. None of them is required by any of the findings
in this phase, and each would be a column with no reader. `notice_deadline` (a date) already exists on `contracts` and
is what the notice finding needs. These belong in P1 — see §8.

No AI, no PDF extraction, no invoice ingestion, no observed-spend events.

## 6. Why this precedes docs/63

Doc 63 builds *observed* spend: ingest invoices and card feeds, normalize them into immutable events, attribute them,
and review the attributions. That is the right eventual model and it is a large lift with an external dependency
(a finance source) that does not exist yet.

The purchased side needs none of that. A contract already in the database plus a connector already syncing is enough to
answer "we bought 3,200 and 3,011 exist" — the question customers actually open the product to ask. Doc 63's sequencing
rule ("reports come after reviewed anchors") is respected rather than bypassed: this phase adds the anchor
(`contract_entitlements`) and a reconciliation whose every number is traceable to a row a human entered or a connector
observed. Nothing here reports on unreviewed data, because there is no ingested data to be unreviewed.

## 7. Data model after this phase

```
contracts ──1:N──> contract_entitlements ──> vendors            (canonical, optional)
    │                      │              ──> app_products      (canonical, optional)
    │                      │              ──> apps              (operational, optional)
    │                      │              ──> connectors        (DECLARED measurement source, optional)
    │                      │              ──> files             (evidence document, optional)
    │                      └── purchased_quantity · minimum_quantity · unit_amount + currency + billing_frequency
    │                          · term_start/end · source · confidence
    └── renewal_date · notice_deadline · auto_renew · total_cost · currency        (pre-existing)

connectors ──> app_accounts (provisioned, provider status, freshness)              (pre-existing, 0076–0078)
           ──> directory_application_user_assignments (assigned)                   (pre-existing, 0059–0061)
```

## 8. Next

**P0** — an **entitlement editor**. The DAL write path (`createEntitlementForCurrentUser` /
`updateEntitlementForCurrentUser`) and its parser exist and are tested, but no form calls them, so today a purchased
line can only be created by a direct database write. Until that ships the feature is verifiable but not usable. Also
P0: the staging apply of 0083, and a portfolio surface for the two rules the contract page filters out
(`possible_duplicate_entitlement`, `discovered_source_without_entitlement`) — both are cross-contract by nature and
have nowhere to render yet.

**P1** — `discount_percent` / `minimum_commitment_amount` / `notice_period_days` / termination text on contracts; a
vendor-level dedupe finding backed by `vendors.normalized_name`; the `application_matches` matcher that would let the
directory-assigned count join a contract without a per-line connector declaration; contract → canonical vendor
backfill.

**Not before a source exists** — anything that claims billable or active. Those stay `unavailable` until a licensing or
usage feed is built, and no finding may imply them.

## 9. One thing found on the way, for another workstream

`src/lib/database.types.ts` is **stale**: it predates migrations 0076–0081 and is missing `app_accounts`,
`connector_run_resource_discovery`, `oauth_completion_jobs`, and every `product_app_account_*` /
`product_oauth_completion_job_status` / `runner_promote_saas_*` signature.

Regenerating it with `scripts/gen-types-local.sh` — the documented, correct way — **breaks two assertions in**
`src/lib/server/connector-vault/oauth-handoff-architecture.test.ts`, because the regenerated file names the nine
`oauth_completer_*` functions and that guard treats any `src/` mention of them as a capability violation. The guard is
scanning a file that describes the database rather than reaching into it, so this is a guard-scope question for the
OAuth workstream to settle, not something this phase should decide.

**This phase therefore did not ship the regeneration.** It added only the `contract_entitlements` block, taken verbatim
from the generated output and spliced in at its alphabetical position, leaving the rest of the file byte-identical
(135 lines added, nothing changed). Anyone regenerating the file for another reason will hit the same two failures and
should read this section first.
