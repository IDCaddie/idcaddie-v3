// Phase 10 — the typed contract for the COMMERCIAL-analytics engine. Provider-neutral, COMPUTE-ONLY. It consumes purchased lines
// (contract_entitlements, 0083), the discovered evidence a caller has already loaded, and the Phase-7B capability resolution, and
// produces a per-line reconciliation plus immutable, deterministic commercial FINDINGS. It writes NOTHING (no migration, table,
// RPC, route, network, DB read, Date.now, env, flag) — `detectedAt` is injected by the caller so the engine stays deterministic.
//
// THIS ENGINE IS THE COMMERCIAL COUNTERPART TO governance-analytics, NOT AN EXTENSION OF IT. The governance engine proves ACCESS
// TOPOLOGY and its prose is forbidden from mentioning cost, licence, savings or usage. This one is allowed to talk about money —
// under its own, equally strict boundary:
//
//   * It NEVER claims usage, activity, last-login, or that a person is not using something. No source produces that.
//   * It NEVER claims a seat is BILLABLE. No source produces that either (license_evaluations has existed since 0001 and has
//     never been written by anything).
//   * It NEVER says "safe to remove", "delete", or "reclaim" as an instruction — an opportunity is a figure to review.
//   * Every money figure names the arithmetic that produced it and is bounded by the contracted minimum.
//   * An estimate is never presented as realized saving.
//
// THE FIVE QUANTITIES ARE NEVER COLLAPSED. purchased / assigned / provisioned / billable / active are different facts from
// different sources (0083's header records them in full). Two of them have NO source today, and this engine reports those as
// unavailable — with the capability model's own explanation — rather than as zero.

import type { CapabilityStatus } from "@/lib/canonical/capabilities";

// ── the five quantities ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const CONCEPTS = ["purchased", "assigned", "provisioned", "billable", "active"] as const;
export type Concept = (typeof CONCEPTS)[number];

export const CONCEPT_LABEL: Readonly<Record<Concept, string>> = {
  purchased: "Purchased",
  assigned: "Assigned",
  provisioned: "Provisioned",
  billable: "Billable",
  active: "Active",
};

// What each concept MEANS, in the words a customer reads next to the number. These are the definitions the whole feature stands
// on; if two surfaces ever disagree about what "provisioned" counts, this is the line that settles it.
export const CONCEPT_DEFINITION: Readonly<Record<Concept, string>> = {
  purchased: "What the contract records as bought.",
  assigned: "Identities the directory grants access to.",
  provisioned: "Accounts that exist in the vendor's own system.",
  billable: "Accounts the vendor charges for.",
  active: "Accounts someone has actually used.",
};

// A measurement, or an honest account of why there isn't one. `value` appears in exactly one variant, so a caller cannot render a
// number for a concept that has none — the type is the guard.
export type Measure =
  // Observed or recorded. `basis` names where the number came from, in words.
  | { readonly state: "measured"; readonly value: number; readonly asOf: string | null; readonly basis: string }
  // Purchased only: the line exists but nobody entered a quantity. NOT zero.
  | { readonly state: "not_recorded"; readonly explanation: string }
  // No connector has been declared as the measurement source for this line, so there is nothing to compare against.
  | { readonly state: "not_measured"; readonly explanation: string }
  // The capability model says this cannot be answered — unbuilt, unconnected, failed, or stale. Carries ITS explanation verbatim,
  // so the product has one vocabulary for "we cannot know" instead of two.
  | { readonly state: "unavailable"; readonly explanation: string };

export const measuredValue = (m: Measure): number | null => (m.state === "measured" ? m.value : null);

// ── the comparison ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Deliberately four outcomes, not a signed number. A caller that received `surplus: -12` would have to know which direction is
// which; these names cannot be misread, and "not comparable" is a first-class answer rather than a zero.
export type Gap =
  | { readonly state: "not_comparable"; readonly reason: string }
  | { readonly state: "aligned"; readonly quantity: number }
  | { readonly state: "purchase_exceeds_discovered"; readonly purchased: number; readonly discovered: number; readonly surplus: number }
  | { readonly state: "discovered_exceeds_purchase"; readonly purchased: number; readonly discovered: number; readonly excess: number };

// ── the money ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Only three cadences can be put on an annual footing from a unit price alone. `multi_year` needs a term length this model does
// not require, and `one_time` is not recurring — for both, the honest answer is that no annual figure follows, not a guess.
export const PERIODS_PER_YEAR: Readonly<Record<string, number>> = { monthly: 12, quarterly: 4, annual: 1 };

export type Opportunity =
  | { readonly state: "not_estimable"; readonly reason: string }
  | { readonly state: "none"; readonly reason: string }
  | {
      readonly state: "estimated";
      readonly reducibleQuantity: number;
      readonly annualAmount: number;
      readonly currency: string;
      readonly floor: number | null;          // the contracted minimum that stopped the reduction, when one applied
      readonly basis: string;                 // the arithmetic, in words — never a bare number
    };

export type Provenance = {
  readonly source: string;
  readonly confidence: "high" | "medium" | "low";
  readonly hasEvidenceDocument: boolean;
};

// ── the per-line reconciliation ──────────────────────────────────────────────────────────────────────────────────────────────
export type EntitlementReconciliation = {
  readonly entitlementId: string;
  readonly contractId: string;
  readonly label: string;                     // sku, else plan name, else a neutral placeholder — never a raw id
  readonly unit: string;
  readonly measures: Readonly<Record<Concept, Measure>>;
  readonly gap: Gap;
  readonly opportunity: Opportunity;
  readonly provenance: Provenance;
  readonly staleEvidence: boolean;            // the discovered side includes rows not re-confirmed by the last discovery
};

// ── findings ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CommercialSeverity = "info" | "low" | "medium" | "high";
export const SEVERITY_RANK: Readonly<Record<CommercialSeverity, number>> = { info: 0, low: 1, medium: 2, high: 3 };

// Evidence quality, kept SEPARATE from severity and never folded in. It is additionally CAPPED by the provenance of the
// entitlement it derives from: arithmetic over a low-confidence manual entry cannot yield a high-confidence finding.
export type CommercialConfidence = "high" | "medium" | "low";

export type CommercialCategory =
  | "reconciliation"   // purchased vs discovered disagree
  | "coverage"         // something commercial is unrecorded or unmeasured
  | "commitment"       // renewal / notice timing
  | "opportunity"      // money that could be recovered at the next renewal
  | "duplication";     // the same thing appears to have been bought twice

export const COMMERCIAL_RULE_IDS = [
  "purchase_exceeds_discovered",
  "discovered_exceeds_purchase",
  "reducible_purchased_quantity",
  "inactive_provisioned_accounts",
  "entitlement_not_measured",
  "contract_without_entitlement",
  "discovered_source_without_entitlement",
  "renewal_approaching",
  "auto_renewal_notice_approaching",
  "possible_duplicate_entitlement",
] as const;
export type CommercialRuleId = (typeof COMMERCIAL_RULE_IDS)[number];

export type CommercialSubjectType = "contract" | "entitlement" | "connection";

// Bounded evidence: named integer counts, an optional money figure with its basis, and the provenance the finding inherited.
// NO free text from a provider, no emails, no external ids, no names — a label belongs in the presenter, resolved from a key.
export type CommercialEvidence = {
  readonly counts: Readonly<Record<string, number>>;
  readonly money?: { readonly amount: number; readonly currency: string; readonly basis: string };
  readonly provenance?: Provenance;
  readonly thresholdDays?: number;
};

export type CommercialFinding = {
  readonly id: string;
  readonly ruleId: CommercialRuleId;
  readonly category: CommercialCategory;
  readonly severity: CommercialSeverity;
  readonly confidence: CommercialConfidence;
  readonly subjectType: CommercialSubjectType;
  readonly subjectId: string;
  readonly relatedIds: readonly string[];
  readonly evidence: CommercialEvidence;
  readonly staleEvidence: boolean;
  readonly detectedAt: string;
};

// Deterministic, injective finding id. Unlike the governance engine this folds NO free text — every part is a rule id from the
// closed catalog above or a canonical row UUID — so a plain join is already collision-free and a sha256 would buy nothing but a
// hash to explain. (ponytail: no digest; if a non-UUID subject is ever added, fold a length tag in as governance/finding-id.ts does.)
export const commercialFindingId = (ruleId: CommercialRuleId, subjectId: string, relatedIds: readonly string[] = []): string =>
  `commercial:${ruleId}:${[subjectId, ...[...relatedIds].sort()].join("+")}`;

export type CommercialSummary = {
  readonly total: number;
  readonly bySeverity: Readonly<Record<CommercialSeverity, number>>;
  // The annualized opportunity, per currency. NEVER summed across currencies — there is no FX source (docs/63 §9 proposes one and
  // it does not exist), so a single total would be a fabricated conversion.
  readonly annualOpportunityByCurrency: Readonly<Record<string, number>>;
};

// What the engine needs to know about each concept's source. The caller resolves these with the Phase-7B capability model, so
// this engine never hardcodes "Slack cannot do usage" — when a licensing or usage feed is built, the answer changes there.
export type ConceptCapabilities = {
  readonly assigned: CapabilityStatus;      // capability: "assignments"
  readonly provisioned: CapabilityStatus;   // capability: "app_accounts"
  readonly billable: CapabilityStatus;      // capability: "licenses"
  readonly active: CapabilityStatus;        // capability: "usage"
};
