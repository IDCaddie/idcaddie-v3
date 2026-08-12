// Phase 10 — the commercial findings engine.
//
// PURE and DETERMINISTIC. It reads nothing, writes nothing, and does not call the clock: `now` and `detectedAt` are injected, so
// the same input always produces the same findings in the same order. Ten rules, one closed catalog (types.ts), message KEYS only
// — the prose lives in the presenter, exhaustively, so a new rule cannot ship without reviewed copy.
//
// WHAT IT REFUSES TO EMIT. Three of the ten findings a first reading of this problem asks for do not exist here, because their
// evidence does not exist:
//
//   "assigned > active"  and  "billable > active"   — nothing produces active. The reconciliation reports it `unavailable`.
//   any per-person reclaim list                     — that needs billable and active. Nothing produces either.
//
// Emitting them against provider lifecycle status (`account_status`) would be the easy version and it would be wrong: an account
// that exists and is not suspended is not an account someone used. When a licensing or usage feed is built, those rules belong
// here, evidenced.
//
// CONFIDENCE IS CAPPED BY PROVENANCE. Arithmetic over a hand-entered, low-confidence quantity is a low-confidence finding no
// matter how clean the subtraction. A number is only ever as good as where it came from.

import { daysUntil, renewalFlag } from "@/lib/data/contract-attention";
import type { EntitlementInput } from "./reconcile";
import type {
  CommercialConfidence, CommercialFinding, CommercialRuleId, CommercialSeverity, CommercialSummary,
  EntitlementReconciliation, Provenance,
} from "./types";
import { SEVERITY_RANK, commercialFindingId } from "./types";

export type ContractFacts = {
  readonly id: string;
  readonly renewalDate: string | null;
  readonly endDate: string | null;
  readonly noticeDeadline: string | null;
  readonly autoRenew: boolean;
};

// One connector's account evidence, as the caller already loaded it (product_app_account_counts, 0078).
export type ConnectionFacts = {
  readonly connectionId: string;
  readonly currentAccounts: number;
  readonly inactiveAccounts: number;
  readonly staleAccounts: number;
};

export type CommercialInput = {
  readonly contracts: readonly ContractFacts[];
  readonly entitlements: readonly EntitlementInput[];
  readonly reconciliations: readonly EntitlementReconciliation[];
  readonly connections: readonly ConnectionFacts[];
  readonly now: Date;
  readonly detectedAt: string;
};

// The notice window. 30 days is the same bucket the renewal flags already use, so the product has one idea of "soon".
const NOTICE_WINDOW_DAYS = 30;

const RANK: Readonly<Record<CommercialConfidence, number>> = { low: 0, medium: 1, high: 2 };
// A finding is never more confident than the record it was derived from.
const cap = (rule: CommercialConfidence, p: Provenance | undefined): CommercialConfidence =>
  p === undefined ? rule : RANK[p.confidence] < RANK[rule] ? p.confidence : rule;

export function evaluateCommercial(input: CommercialInput): readonly CommercialFinding[] {
  const findings: CommercialFinding[] = [];
  const byId = new Map(input.entitlements.map((e) => [e.id, e]));

  const emit = (
    ruleId: CommercialRuleId,
    category: CommercialFinding["category"],
    severity: CommercialSeverity,
    confidence: CommercialConfidence,
    subjectType: CommercialFinding["subjectType"],
    subjectId: string,
    evidence: CommercialFinding["evidence"],
    opts: { relatedIds?: readonly string[]; staleEvidence?: boolean } = {},
  ) => {
    const relatedIds = opts.relatedIds ?? [];
    findings.push({
      id: commercialFindingId(ruleId, subjectId, relatedIds),
      ruleId, category, severity, confidence, subjectType, subjectId,
      relatedIds: [...relatedIds].sort(),
      evidence,
      staleEvidence: opts.staleEvidence ?? false,
      detectedAt: input.detectedAt,
    });
  };

  // ── per purchased line ─────────────────────────────────────────────────────────────────────────────────────────────────
  for (const r of input.reconciliations) {
    const e = byId.get(r.entitlementId);

    if (r.gap.state === "purchase_exceeds_discovered") {
      emit("purchase_exceeds_discovered", "reconciliation", "medium", cap("high", r.provenance), "entitlement", r.entitlementId, {
        counts: { purchased: r.gap.purchased, provisioned: r.gap.discovered, surplus: r.gap.surplus },
        provenance: r.provenance,
      }, { relatedIds: [r.contractId], staleEvidence: r.staleEvidence });
    }

    // More accounts exist than were bought. This is money OWED, not money available, and it is the one commercial finding that
    // gets high severity on its own: a true-up is discovered by the vendor if it is not discovered here.
    if (r.gap.state === "discovered_exceeds_purchase") {
      emit("discovered_exceeds_purchase", "reconciliation", "high", cap("high", r.provenance), "entitlement", r.entitlementId, {
        counts: { purchased: r.gap.purchased, provisioned: r.gap.discovered, excess: r.gap.excess },
        provenance: r.provenance,
      }, { relatedIds: [r.contractId], staleEvidence: r.staleEvidence });
    }

    if (r.opportunity.state === "estimated") {
      emit("reducible_purchased_quantity", "opportunity", "medium", cap("medium", r.provenance), "entitlement", r.entitlementId, {
        counts: { reducibleQuantity: r.opportunity.reducibleQuantity, ...(r.opportunity.floor !== null ? { contractedMinimum: r.opportunity.floor } : {}) },
        money: { amount: r.opportunity.annualAmount, currency: r.opportunity.currency, basis: r.opportunity.basis },
        provenance: r.provenance,
      }, { relatedIds: [r.contractId], staleEvidence: r.staleEvidence });
    }

    // A recorded purchase nobody has pointed at a source. Low severity because nothing is wrong — it is simply unverifiable
    // until someone declares which connector measures it.
    if (e && e.measuredByConnectionId === null) {
      emit("entitlement_not_measured", "coverage", "low", "high", "entitlement", r.entitlementId, {
        counts: r.measures.purchased.state === "measured" ? { purchased: r.measures.purchased.value } : {},
        provenance: r.provenance,
      }, { relatedIds: [r.contractId] });
    }
  }

  // ── per contract ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const entitlementsByContract = new Map<string, EntitlementInput[]>();
  for (const e of input.entitlements) {
    const list = entitlementsByContract.get(e.contractId);
    if (list) list.push(e);
    else entitlementsByContract.set(e.contractId, [e]);
  }

  for (const c of input.contracts) {
    const lines = entitlementsByContract.get(c.id) ?? [];

    if (lines.length === 0) {
      emit("contract_without_entitlement", "coverage", "low", "high", "contract", c.id, { counts: { entitlements: 0 } });
    }

    // Renewal. The date arithmetic is contract-attention's, not a second copy of it. Only surfaced for contracts that carry
    // commercial content — a renewal date with nothing purchased against it is already the finding above.
    if (lines.length > 0) {
      const flag = renewalFlag(c.renewalDate, c.endDate, input.now);
      if (flag === "due30" || flag === "due90") {
        const effective = c.renewalDate ?? c.endDate;
        emit("renewal_approaching", "commitment", flag === "due30" ? "high" : "medium", "high", "contract", c.id, {
          counts: { daysRemaining: effective === null ? 0 : daysUntil(effective, input.now), entitlements: lines.length },
          thresholdDays: flag === "due30" ? 30 : 90,
        }, { relatedIds: lines.map((l) => l.id) });
      }
    }

    // Auto-renewal notice. The most expensive silent failure available to a customer: miss the window and the term renews in
    // full. High severity regardless of whether a line is attached, because the money is the contract's.
    if (c.autoRenew && c.noticeDeadline !== null) {
      const days = daysUntil(c.noticeDeadline, input.now);
      if (days >= 0 && days <= NOTICE_WINDOW_DAYS) {
        emit("auto_renewal_notice_approaching", "commitment", "high", "high", "contract", c.id, {
          counts: { daysRemaining: days, entitlements: lines.length },
          thresholdDays: NOTICE_WINDOW_DAYS,
        }, { relatedIds: lines.map((l) => l.id) });
      }
    }
  }

  // ── per connection ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const measuredConnections = new Set(
    input.entitlements.map((e) => e.measuredByConnectionId).filter((x): x is string => x !== null),
  );

  for (const conn of input.connections) {
    // A connector holding real accounts that no purchased line accounts for. This is the untracked-spend signal: something is
    // being paid for somewhere, and no contract in the workspace describes it.
    if (conn.currentAccounts > 0 && !measuredConnections.has(conn.connectionId)) {
      emit("discovered_source_without_entitlement", "coverage", "medium", "high", "connection", conn.connectionId, {
        counts: { provisioned: conn.currentAccounts },
      }, { staleEvidence: conn.staleAccounts > 0 });
    }

    // Accounts the PROVIDER reports as inactive. Deliberately carries NO money: whether a suspended account is still billed is
    // a vendor-by-vendor billing rule, and no billing source exists to answer it. A count for review, not a saving.
    if (conn.inactiveAccounts > 0) {
      const related = input.entitlements.filter((e) => e.measuredByConnectionId === conn.connectionId).map((e) => e.id);
      emit("inactive_provisioned_accounts", "reconciliation", "low", "high", "connection", conn.connectionId, {
        counts: { inactive: conn.inactiveAccounts, provisioned: conn.currentAccounts },
      }, { relatedIds: related, staleEvidence: conn.staleAccounts > 0 });
    }
  }

  // ── duplication ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // The same canonical vendor or product bought on two DIFFERENT contracts with overlapping terms. Matched on canonical row ids
  // only — never on a name, because two rows spelled "Slack" prove nothing and this heuristic is low confidence already.
  for (const [a, b] of overlappingPairs(input.entitlements)) {
    emit("possible_duplicate_entitlement", "duplication", "medium", "low", "entitlement", a.id, {
      counts: {
        ...(a.purchasedQuantity !== null ? { purchasedHere: a.purchasedQuantity } : {}),
        ...(b.purchasedQuantity !== null ? { purchasedThere: b.purchasedQuantity } : {}),
      },
    }, { relatedIds: [b.id, a.contractId, b.contractId] });
  }

  // Deterministic order: severity first (the engine's own ranking, never re-derived downstream), then rule, then id.
  return findings.sort(
    (x, y) =>
      SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
      x.ruleId.localeCompare(y.ruleId) ||
      x.id.localeCompare(y.id),
  );
}

// Pairs of lines on different contracts sharing a canonical vendor or product, whose terms overlap. A line with no term is
// treated as open-ended: "we do not know when it ends" is not evidence that it has ended.
function overlappingPairs(entitlements: readonly EntitlementInput[]): Array<[EntitlementInput, EntitlementInput]> {
  const pairs: Array<[EntitlementInput, EntitlementInput]> = [];
  const sorted = [...entitlements].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i];
      const b = sorted[j];
      if (a.contractId === b.contractId) continue;   // two lines on one contract are a breakdown, not a duplicate
      const sameThing =
        (a.appProductId !== null && a.appProductId === b.appProductId) ||
        (a.vendorId !== null && a.vendorId === b.vendorId);
      if (!sameThing) continue;
      if (termsOverlap(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

const termsOverlap = (a: EntitlementInput, b: EntitlementInput): boolean =>
  (a.termEnd === null || b.termStart === null || a.termEnd >= b.termStart) &&
  (b.termEnd === null || a.termStart === null || b.termEnd >= a.termStart);

// The summary is the engine's OWN count, and downstream surfaces must take it from here rather than re-counting the array — the
// documented single source of truth, for the reason Phase 7A records: two derivations are a place for two answers.
export function summarize(findings: readonly CommercialFinding[]): CommercialSummary {
  const bySeverity: Record<CommercialSeverity, number> = { info: 0, low: 0, medium: 0, high: 0 };
  const annualOpportunityByCurrency: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] += 1;
    // Only the opportunity rule contributes money, and only in its own currency. No FX source exists, so currencies are never
    // summed together — a single "total savings" number would be a conversion nobody performed.
    if (f.ruleId === "reducible_purchased_quantity" && f.evidence.money) {
      const { currency, amount } = f.evidence.money;
      annualOpportunityByCurrency[currency] = Math.round(((annualOpportunityByCurrency[currency] ?? 0) + amount) * 100) / 100;
    }
  }
  return { total: findings.length, bySeverity, annualOpportunityByCurrency };
}
