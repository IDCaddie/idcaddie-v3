// Phase 10 — the single resolver for commercial-finding copy. The engine stamps rule ids, severity, confidence and bounded
// evidence; this module is the ONLY place those become sentences. RULE_PROSE is EXHAUSTIVE over CommercialRuleId (a new rule is a
// compile error), so no commercial finding can render without reviewed copy.
//
// THE TRUTHFULNESS BOUNDARY, which is DIFFERENT from the access one. docs/71 forbids access prose from mentioning cost, licence,
// savings or usage, because the directory graph cannot evidence any of them. Commercial prose is allowed to talk about money —
// and is bound by its own rules instead:
//
//   * NEVER claims usage, activity, last login, or that a person is not using something. No source produces that.
//   * NEVER claims a seat is BILLABLE. No source produces that either.
//   * NEVER says "remove", "delete", "reclaim" or "safe to" — a finding is a figure to review, not an instruction.
//   * NEVER presents an estimate as a realized saving; the word is always "estimated" or "could", with the arithmetic available.
//   * NEVER calls a provider-suspended account "unused" — `account_status` is a lifecycle bucket, not evidence of use.
//   * NEVER uses the severity word "critical", matching the access engine's conservatism.
//
// Pure module. No I/O, no server import — safe anywhere, though loaders resolve findings server-side and hand finished view
// models to the client.

import type { CommercialFinding, CommercialRuleId, CommercialSeverity } from "@/lib/server/commercial-analytics/types";
import type { StatusTone } from "@/components/status-tokens";
// Severity → tone/label is BORROWED, not re-declared. The two engines use the same four-level scale on purpose, and a second
// mapping is how "high" ends up amber on one page and red on another.
import { severityTone, severityLabel, confidenceLabel } from "./governance-presenter";

export type CommercialProse = { title: string; summary: string; guidance: string | null };

export const COMMERCIAL_RULE_PROSE: Record<CommercialRuleId, CommercialProse> = {
  purchase_exceeds_discovered: {
    title: "More purchased than the connector found",
    summary: "The recorded purchased quantity is higher than the number of accounts the declared connector confirmed.",
    guidance: "Confirm whether the remaining quantity is held for planned onboarding before the next renewal.",
  },
  discovered_exceeds_purchase: {
    title: "More accounts than the contract records",
    summary: "The declared connector confirmed more accounts than the recorded purchased quantity for this line.",
    guidance: "Check the purchased quantity against the order form — a shortfall is usually settled at renewal.",
  },
  reducible_purchased_quantity: {
    title: "Purchased quantity could be reduced at renewal",
    summary:
      "Part of the purchased quantity has no confirmed account behind it. The estimate values that difference at the recorded unit price and billing frequency, and stops at any contracted minimum.",
    guidance: "Review the estimate against your renewal plan; it does not account for onboarding you have already committed to.",
  },
  inactive_provisioned_accounts: {
    // Deliberately says what the provider reports, not what it means. Whether a suspended account is still charged for is a
    // vendor billing rule, and no billing source exists to answer it.
    title: "Accounts the provider reports as inactive",
    summary: "The connector found accounts the provider marks inactive. Whether they are still charged for is not represented.",
    guidance: "Review these with the vendor's billing terms before the next renewal.",
  },
  entitlement_not_measured: {
    title: "No measurement source declared",
    summary: "This purchased line has no connector declared as its measurement source, so its quantity cannot be compared with anything.",
    guidance: "Declare the connector that observes this product to enable the comparison.",
  },
  contract_without_entitlement: {
    title: "No purchased quantity recorded",
    summary: "This contract records no purchased line, so what it bought is not represented.",
    guidance: "Add a line from the order form to make this contract comparable with discovered accounts.",
  },
  discovered_source_without_entitlement: {
    title: "Accounts with no contract recorded",
    summary: "This connector holds current accounts that no purchased line accounts for.",
    guidance: "Record the governing contract, or declare this connector as the measurement source on an existing line.",
  },
  renewal_approaching: {
    title: "Renewal approaching",
    summary: "This contract's renewal or end date falls within the review window, and it carries recorded purchased quantities.",
    guidance: "Review the quantities on this contract before the renewal is agreed.",
  },
  auto_renewal_notice_approaching: {
    title: "Auto-renewal notice period closing",
    summary: "This contract renews automatically and its notice deadline falls within the review window.",
    guidance: "Decide before the deadline — after it, the contract renews on its existing terms.",
  },
  possible_duplicate_entitlement: {
    title: "Same product purchased on two contracts",
    summary: "Two contracts record a purchased line for the same vendor or product with overlapping terms.",
    guidance: "Confirm whether both are intentional — separate business units often buy the same product deliberately.",
  },
};

export const commercialProse = (ruleId: CommercialRuleId): CommercialProse => COMMERCIAL_RULE_PROSE[ruleId];

// CommercialSeverity and GovernanceSeverity are the same four levels by design, so this is a pass-through rather than a parallel
// table. If the two scales ever diverge, this line is where that decision has to be made explicitly.
export const commercialTone = (s: CommercialSeverity): StatusTone => severityTone(s);

// Money, formatted with its currency named. There is no FX source, so an amount is ALWAYS shown in the currency it was recorded
// in — never converted, never totalled across currencies.
export function formatOpportunity(money: { amount: number; currency: string }): string {
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency, maximumFractionDigits: 0 }).format(money.amount)} / year`;
}

export type CommercialFindingView = {
  readonly id: string;
  readonly ruleId: CommercialRuleId;
  readonly title: string;
  readonly summary: string;
  readonly guidance: string | null;
  readonly severity: CommercialSeverity;
  readonly severityLabel: string;
  readonly tone: StatusTone;
  readonly confidence: "high" | "medium" | "low";
  readonly confidenceLabel: string;
  readonly staleEvidence: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly money: string | null;
  readonly basis: string | null;          // the arithmetic behind the money — always available where money is
  readonly provenanceNote: string | null; // where the underlying figure came from
  readonly subjectType: CommercialFinding["subjectType"];
  readonly subjectId: string;
};

const SOURCE_LABEL: Record<string, string> = {
  contract_document: "read from the contract document",
  order_form: "read from the order form",
  invoice: "read from an invoice",
  vendor_portal: "read from the vendor portal",
  manual_entry: "entered manually",
};

export function toCommercialFindingView(f: CommercialFinding): CommercialFindingView {
  const prose = commercialProse(f.ruleId);
  const p = f.evidence.provenance;
  return {
    id: f.id,
    ruleId: f.ruleId,
    title: prose.title,
    summary: prose.summary,
    guidance: prose.guidance,
    severity: f.severity,
    severityLabel: severityLabel(f.severity),
    tone: commercialTone(f.severity),
    confidence: f.confidence,
    confidenceLabel: confidenceLabel(f.confidence),
    staleEvidence: f.staleEvidence,
    counts: f.evidence.counts,
    money: f.evidence.money ? formatOpportunity(f.evidence.money) : null,
    basis: f.evidence.money?.basis ?? null,
    provenanceNote: p ? `Figure ${SOURCE_LABEL[p.source] ?? p.source}${p.hasEvidenceDocument ? ", with an attached document" : ""} · ${p.confidence} confidence` : null,
    subjectType: f.subjectType,
    subjectId: f.subjectId,
  };
}
