// Server-only RESOLVER + IDENTITY-MATCHING DESIGN — the design/type foundation for the moat engine that will
// assemble validated discovery signals into the canonical app graph (docs/42 §62). The canonical graph schema
// (vendors / app_products / app_aliases / apps.canonical_app_id + instance discriminators) exists and is
// verified on staging + production, but **the resolver does not exist yet and nothing populates
// apps.canonical_app_id yet.** This module is **pure TYPES + in-memory classification helpers only** — there
// is NO live resolver job, NO DB write, NO canonical_app_id write, NO app_alias write, NO app_user→person
// match write, NO provider API call, NO token/credential handling, NO connector_secrets access, NO sync.
//
// THE FUTURE FLOW this models (none of it runs here): validated discovery signals → DETERMINISTIC resolver →
// low-confidence HUMAN REVIEW → canonical_app_id assignment → app_user→person matching → baseline metrics →
// canonical/vendor/product rollups → recommendations.
//
// FAIL CLOSED: matching is deterministic-FIRST, probabilistic-SECOND; anything below a deterministic match
// routes to human review and MUST NOT auto-merge. Unknown/ambiguous input fails closed into `human_review`.
// Distinct app instances are NEVER blindly merged: instance_domain / external_instance_id are the merge/
// no-merge keys, so Atlassian/Jira/Flywheel and Atlassian/Jira/Perpetua stay distinct `apps` rows under one
// canonical product. The identity graph is app_user → person (and identity_account → person) — there is NO
// `identity_account_id` on app_user_identity_matches, and none is introduced here.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// It has NO imports (pure TS types + logic) — no DB / Supabase / provider client / fetch / connector_secrets.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/resolution is server-only and must not be imported in client code");
}

// ── Confidence + signals ────────────────────────────────────────────────────────────────────────────────

// Resolution confidence tiers, ordered most→least confident. `deterministic` is the ONLY tier that may
// auto-assign; everything below routes to human review. `human_review` is the fail-closed floor.
export type ResolutionConfidence =
  | "deterministic"
  | "probabilistic_high"
  | "probabilistic_low"
  | "human_review";

// What a resolver/reviewer should do. Only a deterministic match auto-assigns; everything else needs a human.
export type ResolutionAction = "auto_assign" | "human_review";

// Deterministic-FIRST app-resolution signals (a structured identity key) + probabilistic-SECOND ones
// (name/domain similarity). The `*_similarity` signals are fuzzy and never auto-merge on their own.
export type AppResolutionSignal =
  // deterministic — a structured key that uniquely identifies the instance/product
  | "instance_domain"
  | "external_instance_id"
  | "instance_url"
  | "provider_app_id"
  | "oauth_client_id"
  | "sso_app_id"
  | "known_domain"
  | "vendor_identifier"
  | "product_identifier"
  // probabilistic — fuzzy similarity, routes to review
  | "vendor_name_similarity"
  | "product_name_similarity"
  | "domain_similarity"
  | "contract_vendor_similarity";

// Identity-matching signals (app_user → person). Deterministic first (exact normalized email / verified
// external id), then secondary hints (aliases / manager / HR fields) that route to review.
export type IdentityMatchSignal =
  // deterministic
  | "exact_normalized_email"
  | "verified_external_id"
  // probabilistic / secondary
  | "email_alias"
  | "manager_chain"
  | "hr_identity_field"
  | "display_name_similarity";

export type ResolutionSignal = AppResolutionSignal | IdentityMatchSignal;

// The signals that may auto-assign. Everything NOT in this set is probabilistic and routes to human review.
const DETERMINISTIC_SIGNALS: ReadonlySet<ResolutionSignal> = new Set<ResolutionSignal>([
  "instance_domain", "external_instance_id", "instance_url", "provider_app_id", "oauth_client_id",
  "sso_app_id", "known_domain", "vendor_identifier", "product_identifier",
  "exact_normalized_email", "verified_external_id",
]);

// ── Input + candidate shapes ────────────────────────────────────────────────────────────────────────────

// A single VALIDATED discovery signal to resolve into a canonical app/instance assignment. Every field is a
// non-secret label / id / name — never a token, OAuth code, or credential. All optional; absent = unknown.
export type DiscoveryResolutionInput = {
  // deterministic keys
  instanceDomain?: string | null; // e.g. "flywheel.atlassian.net" — a merge/no-merge key
  externalInstanceId?: string | null; // the provider's instance id — a merge/no-merge key
  instanceUrl?: string | null; // e.g. "https://flywheel.atlassian.net/wiki"
  providerAppId?: string | null;
  oauthClientId?: string | null; // a public client id label only — NOT a client secret
  ssoAppId?: string | null;
  knownDomain?: string | null; // a domain with a known vendor/product mapping
  vendorIdentifier?: string | null; // an explicit vendor identifier
  productIdentifier?: string | null; // an explicit canonical product identifier
  // probabilistic signals
  vendorName?: string | null;
  productName?: string | null;
  appName?: string | null;
  appDomain?: string | null;
  contractVendorName?: string | null;
  // org context — owner/paying/responsible org influences merge/no-merge decisions
  ownerOrgId?: string | null;
  payingOrgId?: string | null;
  responsibleOrgId?: string | null;
};

// A candidate canonical-product grouping for an `apps` instance. `canonicalAppProductId` is the existing
// app_products row it would group under (null = no existing product matched → a new-product candidate). The
// instance discriminators are carried through so the resolver keeps it a SEPARATE apps row (no collapse).
export type AppResolutionCandidate = {
  canonicalAppProductId: string | null;
  matchedSignals: readonly AppResolutionSignal[];
  confidence: ResolutionConfidence;
  instanceDomain: string | null; // merge/no-merge key — kept distinct, never collapsed
  externalInstanceId: string | null; // merge/no-merge key
};

// A candidate app_user → person identity match. The match graph is app_user → person: `appUserId` →
// `personId` (null = no person matched → new-person / review candidate). NOTE: there is intentionally NO
// identity_account_id field — identity_accounts link to person via person_id, never to app_user_identity_matches.
export type IdentityMatchCandidate = {
  appUserId: string;
  personId: string | null;
  matchedSignals: readonly IdentityMatchSignal[];
  confidence: ResolutionConfidence;
};

// The resolver's recommended next step for a candidate. Reasons are human-readable provenance for the review
// queue. A deterministic match → auto_assign; anything else → human_review (fail closed, no blind merge).
export type ResolutionDecision = {
  action: ResolutionAction;
  confidence: ResolutionConfidence;
  reasons: readonly string[];
};

// ── Pure helpers (deterministic, in-memory, no I/O) ─────────────────────────────────────────────────────

// Numeric rank for ordering confidence tiers (deterministic highest). Lets callers compare/sort confidences
// and lets tests assert a deterministic match outranks a name-similarity match.
export function confidenceRank(c: ResolutionConfidence): number {
  switch (c) {
    case "deterministic": return 3;
    case "probabilistic_high": return 2;
    case "probabilistic_low": return 1;
    case "human_review": return 0;
  }
}

// Classify confidence from the set of matched signals. ANY deterministic signal → `deterministic`; otherwise
// 2+ probabilistic signals → `probabilistic_high`, exactly 1 → `probabilistic_low`, none → `human_review`
// (fail closed). Deterministic ALWAYS outranks similarity-only matches.
export function classifyResolutionConfidence(matched: readonly ResolutionSignal[]): ResolutionConfidence {
  if (matched.some((s) => DETERMINISTIC_SIGNALS.has(s))) return "deterministic";
  const probabilistic = matched.filter((s) => !DETERMINISTIC_SIGNALS.has(s)).length;
  if (probabilistic >= 2) return "probabilistic_high";
  if (probabilistic === 1) return "probabilistic_low";
  return "human_review";
}

// The deterministic app-resolution signals PRESENT in a discovery input (a non-blank value for the key). This
// is the deterministic-first pass — name/domain similarity is computed separately by the (future) matcher.
export function appResolutionSignals(input: DiscoveryResolutionInput): AppResolutionSignal[] {
  const present = (v: string | null | undefined): boolean => typeof v === "string" && v.trim().length > 0;
  const out: AppResolutionSignal[] = [];
  if (present(input.instanceDomain)) out.push("instance_domain");
  if (present(input.externalInstanceId)) out.push("external_instance_id");
  if (present(input.instanceUrl)) out.push("instance_url");
  if (present(input.providerAppId)) out.push("provider_app_id");
  if (present(input.oauthClientId)) out.push("oauth_client_id");
  if (present(input.ssoAppId)) out.push("sso_app_id");
  if (present(input.knownDomain)) out.push("known_domain");
  if (present(input.vendorIdentifier)) out.push("vendor_identifier");
  if (present(input.productIdentifier)) out.push("product_identifier");
  return out;
}

// Turn a set of matched signals into a decision. ONLY a deterministic match auto-assigns; everything else —
// including no-match — routes to human review (fail closed, no blind merging). Reasons explain the routing.
export function explainResolutionDecision(matched: readonly ResolutionSignal[]): ResolutionDecision {
  const confidence = classifyResolutionConfidence(matched);
  if (confidence === "deterministic") {
    const det = matched.filter((s) => DETERMINISTIC_SIGNALS.has(s));
    return { action: "auto_assign", confidence, reasons: [`deterministic match on ${det.join(", ")}`] };
  }
  if (matched.length === 0) {
    return { action: "human_review", confidence, reasons: ["no deterministic or probabilistic signal — fail closed to human review"] };
  }
  return { action: "human_review", confidence, reasons: [`probabilistic-only match on ${matched.join(", ")} — must not auto-merge`] };
}

// Do two discovery signals describe the SAME operational app instance? Only when their merge/no-merge keys
// (instance_domain / external_instance_id) are present AND equal, and no owning org conflicts. Different
// instance_domain (or external_instance_id) → FALSE: distinct apps rows under the same canonical product,
// never collapsed. Returns false when there is no shared key to compare (fail closed — no blind merge).
export function sameOperationalInstance(a: DiscoveryResolutionInput, b: DiscoveryResolutionInput): boolean {
  const norm = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : null;
  let sharedKeyMatched = false;
  for (const key of ["instanceDomain", "externalInstanceId"] as const) {
    const av = norm(a[key]); const bv = norm(b[key]);
    if (av !== null && bv !== null) {
      if (av !== bv) return false; // a present merge key DIFFERS → distinct instances
      sharedKeyMatched = true;
    }
  }
  // owning-org conflict (owner/paying/responsible) also blocks a merge.
  for (const key of ["ownerOrgId", "payingOrgId", "responsibleOrgId"] as const) {
    const av = norm(a[key]); const bv = norm(b[key]);
    if (av !== null && bv !== null && av !== bv) return false;
  }
  return sharedKeyMatched;
}

// Normalize an email for deterministic identity matching (trim + lowercase). Returns null for blank/invalid.
export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.length > 0 && e.includes("@") ? e : null;
}

// Deterministic identity-match signals between one app_user and one candidate person. Exact normalized email
// or a verified external id → deterministic. Nothing here invents identity_account_id (the match is
// app_user → person). Secondary hints (aliases / manager / HR) are added by the future matcher and route to
// review; this helper covers the deterministic-first pass only.
export function identityMatchSignals(
  appUser: { email?: string | null; verifiedExternalId?: string | null },
  person: { email?: string | null; verifiedExternalId?: string | null },
): IdentityMatchSignal[] {
  const out: IdentityMatchSignal[] = [];
  const ue = normalizeEmail(appUser.email); const pe = normalizeEmail(person.email);
  if (ue !== null && pe !== null && ue === pe) out.push("exact_normalized_email");
  const ux = appUser.verifiedExternalId?.trim(); const px = person.verifiedExternalId?.trim();
  if (ux && px && ux === px) out.push("verified_external_id");
  return out;
}
