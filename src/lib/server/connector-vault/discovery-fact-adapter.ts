// Server-only DISCOVERY FACT REQUEST ADAPTER — the reviewed seam a future authenticated request handler calls
// to (a) STAGE an untrusted discovery fact through the existing SafeParse + RLS-backed `discovery_facts` path
// (PR #141 contract → PR #142 staging helper), and (b) optionally return a READ-ONLY resolver PREVIEW computed
// in memory from the validated fact (PR #140 pure resolver logic). It wires existing pieces only.
//
// SAFE BY DESIGN:
//   * staging goes ONLY through `stageDiscoveryFactForReview` — invalid / token / secret / wrong-tenant facts
//     are rejected BEFORE any DB call, and the insert runs through the INJECTED user-scoped (authenticated,
//     RLS-enforced) `DiscoveryFactStagingStore`. This module imports NO Supabase client and uses NO
//     service-role; it exposes NO HTTP route (a future AUTHENTICATED route handler injects the store and calls
//     these functions — there is no unauthenticated/public ingestion route here);
//   * the resolver PREVIEW is strictly READ-ONLY and in-memory: it predicts an action/confidence/reasons from
//     the validated fact's own content and PERSISTS NOTHING. It never writes the canonical app graph
//     (apps.canonical_app_id / app_aliases / app_user_identity_matches), never auto-assigns, and never updates
//     a staged fact's review_status. The live resolver write path is NOT implemented.
//   * the preview can only compute DETERMINISTIC signals from the fact itself (it has no corpus to run
//     similarity against in memory), so anything without a deterministic instance key fails closed to
//     `human_review` — exactly the no-blind-merge posture.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// Imports only the sibling server-only modules (staging helper, resolver logic, fact contract).

import {
  stageDiscoveryFactForReview,
  stageDiscoveryFactsForReview,
  validateDiscoveryFact,
  type DiscoveryFactStagingStore,
  type StageResult,
} from "./discovery-fact-staging";
import {
  appResolutionSignals,
  explainResolutionDecision,
  type ResolutionDecision,
  type DiscoveryResolutionInput,
} from "./resolution";
import type { DiscoveryFact } from "./discovery-facts";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/discovery-fact-adapter is server-only and must not be imported in client code");
}

// A READ-ONLY resolver preview — a PREDICTION, never persisted, never a graph write.
export type ResolverPreview = { decision: ResolutionDecision };

export type SubmitWithPreviewResult = { stage: StageResult; preview: ResolverPreview | null };

// Map a validated fact onto the DETERMINISTIC resolution-input fields it carries (the merge/no-merge instance
// discriminators + owning-org hints). Probabilistic name/domain similarity is intentionally NOT synthesized
// here — the preview has no in-memory corpus to compare against, so a name-only fact yields no deterministic
// signal and the preview fails closed to human_review.
function factToResolutionInput(fact: DiscoveryFact): DiscoveryResolutionInput {
  const f = fact as Record<string, unknown>;
  const str = (k: string): string | null => (typeof f[k] === "string" ? (f[k] as string) : null);
  return {
    instanceDomain: str("instance_domain"),
    externalInstanceId: str("external_instance_id"),
    instanceUrl: str("instance_url"),
    ownerOrgId: str("owner_org_hint"),
    payingOrgId: str("paying_org_hint"),
    responsibleOrgId: str("responsible_org_hint"),
  };
}

// READ-ONLY preview: validate the fact, then predict its resolution decision in memory. PERSISTS NOTHING,
// takes no store, writes no graph. Returns human_review for anything without a deterministic instance key.
export function previewDiscoveryFactResolution(
  input: unknown,
): { ok: true; preview: ResolverPreview } | { ok: false; reason: "forbidden_material" | "invalid_fact" } {
  const validation = validateDiscoveryFact(input);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const signals = appResolutionSignals(factToResolutionInput(validation.fact));
  return { ok: true, preview: { decision: explainResolutionDecision(signals) } };
}

// The request-adapter seam: stage ONE untrusted fact through the authenticated user-scoped/RLS store. Pure
// delegation to the staging helper — invalid/token/secret/wrong-tenant facts are rejected before any insert.
export async function submitDiscoveryFactForReview(
  store: DiscoveryFactStagingStore,
  tenantId: string,
  input: unknown,
): Promise<StageResult> {
  return stageDiscoveryFactForReview(store, tenantId, input);
}

// Stage MANY untrusted facts through the authenticated user-scoped/RLS store (each validated independently).
export async function submitDiscoveryFactsForReview(
  store: DiscoveryFactStagingStore,
  tenantId: string,
  inputs: readonly unknown[],
): Promise<StageResult[]> {
  return stageDiscoveryFactsForReview(store, tenantId, inputs);
}

// Stage a fact AND return a read-only resolver preview alongside it. The preview is computed in memory and
// PERSISTED NOWHERE; staging still goes through the same validated, RLS-backed path. The preview is null when
// the fact does not validate.
export async function stageAndPreviewDiscoveryFact(
  store: DiscoveryFactStagingStore,
  tenantId: string,
  input: unknown,
): Promise<SubmitWithPreviewResult> {
  const stage = await stageDiscoveryFactForReview(store, tenantId, input);
  const previewed = previewDiscoveryFactResolution(input);
  return { stage, preview: previewed.ok ? previewed.preview : null };
}
