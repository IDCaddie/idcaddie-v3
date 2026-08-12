// Phase 10 — reconcile ONE purchased line against the evidence that measures it.
//
// PURE. No I/O, no clock, no environment. Everything it needs is passed in — the entitlement row, the discovered counts the
// caller already loaded, and the capability resolution from Phase 7B.
//
// THE ONE RULE. A number appears only when something observed or recorded it. Every other outcome is a named state carrying the
// sentence that explains it. There is no path through this file that turns "we cannot know" into 0, which is the entire reason
// the five quantities are modelled separately in the first place.
//
// WHERE EACH NUMBER COMES FROM TODAY:
//   purchased    contract_entitlements.purchased_quantity (0083). NULL = not recorded.
//   provisioned  product_app_account_counts -> accounts.current (0078/0076), for the DECLARED connection only.
//   assigned     directory_application_user_assignments (0059). Reachable only through an accepted application_match (0075),
//                of which there are none, so this reads `unavailable` from the capability model rather than being faked.
//   billable     NO SOURCE. license_evaluations has never been written.
//   active       NO SOURCE. The `usage` capability is vocabulary only.
//
// `accounts.active` is deliberately NOT used as the `active` quantity. It is the PROVIDER'S lifecycle bucket — an account that
// exists and is not suspended (0076's account_status). Using it as usage would be the single most misleading thing this file
// could do, so it is surfaced separately as `inactiveProvisioned`, a count with no money attached.

import type {
  Concept, ConceptCapabilities, EntitlementReconciliation, Gap, Measure, Opportunity, Provenance,
} from "./types";
import { PERIODS_PER_YEAR } from "./types";

// The purchased-side row, as the DAL exposes it.
export type EntitlementInput = {
  readonly id: string;
  readonly contractId: string;
  readonly sku: string | null;
  readonly planName: string | null;
  // Canonical links (0024). Used for duplicate detection, which is why they are ids and never names: two rows spelled "Slack"
  // are not evidence of anything, two rows pointing at the same vendor row are.
  readonly vendorId: string | null;
  readonly appProductId: string | null;
  readonly termStart: string | null;
  readonly termEnd: string | null;
  readonly purchasedQuantity: number | null;
  readonly minimumQuantity: number | null;
  readonly quantityUnit: string;
  readonly unitAmount: number | null;
  readonly currency: string | null;
  readonly billingFrequency: string | null;
  readonly measuredByConnectionId: string | null;
  readonly source: string;
  readonly confidence: "high" | "medium" | "low";
  readonly hasEvidenceDocument: boolean;
};

// The discovered side for ONE connection, exactly as product_app_account_counts returns it (0078).
export type DiscoveredCounts = {
  readonly current: number;
  readonly stale: number;
  readonly inactive: number;      // provider lifecycle bucket among current accounts — NOT "unused"
  readonly lastSeenAt: string | null;
};

const unavailable = (c: { explanation: string }): Measure => ({ state: "unavailable", explanation: c.explanation });

// A capability may contribute a NUMBER only when it is genuinely available; `canShowValue` is the Phase-7B guard and this mirrors
// it rather than re-deciding. Stale still shows, because a retained observation is evidence — flagged, not hidden.
const capabilityAllowsValue = (s: { state: string }): boolean => s.state === "available" || s.state === "stale";

export function reconcileEntitlement(
  entitlement: EntitlementInput,
  discovered: DiscoveredCounts | null,
  capabilities: ConceptCapabilities,
): EntitlementReconciliation {
  const purchased: Measure =
    entitlement.purchasedQuantity === null
      ? { state: "not_recorded", explanation: "No purchased quantity has been recorded for this line. This is not a quantity of zero." }
      : { state: "measured", value: entitlement.purchasedQuantity, asOf: null, basis: "Recorded on the contract." };

  // Provisioned needs BOTH a declared measurement source and a capability that can answer. Missing either is its own state:
  // "nobody said which connector measures this" is a different problem from "the connector cannot tell us".
  let provisioned: Measure;
  if (entitlement.measuredByConnectionId === null) {
    provisioned = {
      state: "not_measured",
      explanation: "No connector has been declared as the measurement source for this line, so its purchased quantity stands alone.",
    };
  } else if (!capabilityAllowsValue(capabilities.provisioned)) {
    provisioned = unavailable(capabilities.provisioned);
  } else if (discovered === null) {
    provisioned = { state: "unavailable", explanation: "The declared connector's account evidence could not be read. This is not a statement that there are none." };
  } else {
    provisioned = {
      state: "measured",
      value: discovered.current,
      asOf: discovered.lastSeenAt,
      basis: "Accounts the declared connector confirmed in its last discovery.",
    };
  }

  // Assigned, billable and active are answered ENTIRELY by the capability model. When a licensing or usage feed is built, this
  // file does not change — the support matrix does.
  const measures: Record<Concept, Measure> = {
    purchased,
    assigned: unavailable(capabilities.assigned),
    provisioned,
    billable: unavailable(capabilities.billable),
    active: unavailable(capabilities.active),
  };

  const gap = compareGap(purchased, provisioned);
  const provenance: Provenance = {
    source: entitlement.source,
    confidence: entitlement.confidence,
    hasEvidenceDocument: entitlement.hasEvidenceDocument,
  };

  return {
    entitlementId: entitlement.id,
    contractId: entitlement.contractId,
    label: entitlement.sku ?? entitlement.planName ?? "Unnamed line",
    unit: entitlement.quantityUnit,
    measures,
    gap,
    opportunity: estimateOpportunity(entitlement, gap),
    provenance,
    staleEvidence: discovered !== null && discovered.stale > 0,
  };
}

// ── the comparison ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export function compareGap(purchased: Measure, discovered: Measure): Gap {
  if (purchased.state !== "measured") {
    return { state: "not_comparable", reason: "No purchased quantity has been recorded, so there is nothing to compare the discovered accounts against." };
  }
  if (discovered.state !== "measured") {
    return { state: "not_comparable", reason: discovered.explanation };
  }
  if (purchased.value === discovered.value) return { state: "aligned", quantity: purchased.value };
  if (purchased.value > discovered.value) {
    return { state: "purchase_exceeds_discovered", purchased: purchased.value, discovered: discovered.value, surplus: purchased.value - discovered.value };
  }
  return { state: "discovered_exceeds_purchase", purchased: purchased.value, discovered: discovered.value, excess: discovered.value - purchased.value };
}

// ── the money ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The ONLY savings claim this engine makes: quantity bought that no account exists for, priced at the recorded unit price and
// cadence, and stopped at the contracted minimum. It says nothing about whether the accounts that DO exist are needed — that
// would require the billable and active evidence nothing produces.
export function estimateOpportunity(entitlement: EntitlementInput, gap: Gap): Opportunity {
  if (gap.state !== "purchase_exceeds_discovered") {
    if (gap.state === "not_comparable") return { state: "not_estimable", reason: gap.reason };
    return { state: "none", reason: "The purchased quantity does not exceed what the connector found." };
  }
  if (entitlement.unitAmount === null || entitlement.currency === null || entitlement.billingFrequency === null) {
    // 0083 makes a priced line carry all three or none, so this is the unpriced case, not a half-recorded one.
    return { state: "not_estimable", reason: "No unit price has been recorded for this line, so the surplus cannot be valued." };
  }
  const periods = PERIODS_PER_YEAR[entitlement.billingFrequency];
  if (periods === undefined) {
    return {
      state: "not_estimable",
      reason: `A ${entitlement.billingFrequency.replace("_", "-")} price cannot be put on an annual footing from the unit price alone.`,
    };
  }

  // The floor. Reducing below a contracted minimum still costs the minimum, so the reduction stops there — leaving it out would
  // overstate savings on exactly the contracts a customer would check.
  const floor = entitlement.minimumQuantity;
  const target = Math.max(floor ?? 0, gap.discovered);
  const reducible = Math.max(0, gap.purchased - target);
  if (reducible === 0) {
    return { state: "none", reason: "The contracted minimum already covers the surplus, so reducing the quantity would not lower the cost." };
  }

  // ponytail: numeric(14,4) arrives as a JS number and is rounded to whole currency units for display. Exact-decimal arithmetic
  // belongs here the day this figure is used to raise a purchase order rather than to start a conversation.
  const annualAmount = Math.round(reducible * entitlement.unitAmount * periods * 100) / 100;
  const floorNote = floor !== null && target === floor ? `, stopping at the contracted minimum of ${floor}` : "";
  return {
    state: "estimated",
    reducibleQuantity: reducible,
    annualAmount,
    currency: entitlement.currency,
    floor,
    basis:
      `${gap.purchased} purchased less ${target} retained${floorNote} = ${reducible} × ` +
      `${entitlement.unitAmount} ${entitlement.currency} ${entitlement.billingFrequency} × ${periods} periods/year.`,
  };
}
