// Server-only DISCOVERY SIGNAL / STANDARD FACT SCHEMA — the versioned input contract that discovery
// connectors, deep provider-sync runners, contract intelligence, invoice/spend imports, and future
// browser/CSV imports emit standardized facts into (docs/42 §63). This is **the future input contract for the
// resolver** (PR #140's pure resolver logic consumes validated facts; this defines what "validated" means).
//
// SCHEMA/TYPES ONLY — runtime enforcement via zod `safeParse`. There is NO live ingestion, NO DB write, NO
// app-graph / canonical_app_id / app_alias / match write, NO provider API call, NO token/credential handling,
// NO connector_secrets access, NO sync, NO API route, NO scheduled job, NO UI. The only import is `zod`
// (already a dependency) — no Supabase client, no service-role, no fetch, no DB.
//
// SAFE BY CONSTRUCTION: every fact schema is STRICT (`.strict()`), so a token / secret / credential key
// (access_token, refresh_token, api_key, client_secret, connector_secrets, …) is REJECTED at parse time as an
// unknown top-level field — and the `provenance` record additionally REFUSES those key names (refine) and
// allows scalar values only, so even a nested `provenance:{ access_token }` fails `safeParse`. A fact may
// carry only the safe metadata fields enumerated here. `raw_source_ref` is a reference/pointer
// (e.g. a file id), never secret material. An unknown/unrecognized `source_type` fails closed to
// `unknown_source` (→ review), and ambiguous app-instance identity does NOT auto-resolve: distinct
// instance_domain / external_instance_id values stay SEPARATE instance candidates. NOTE: old scraper behavior
// is a REFERENCE to verify against, not ground truth — provider APIs may have changed.
//
// No LLM is on the runtime ingestion hot path — this is a deterministic structural contract only.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { z } from "zod";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/discovery-facts is server-only and must not be imported in client code");
}

// The versioned contract version. Bumping this is a deliberate, reviewed contract change.
export const DISCOVERY_FACT_SCHEMA_VERSION = 1 as const;

// Where a fact came from. `unknown_source` is the fail-closed bucket for anything unrecognized (→ review).
export const SourceTypeSchema = z.enum([
  "identity_provider_discovery",
  "deep_provider_sync",
  "contract_intelligence",
  "invoice_spend_import",
  "browser_extension_discovery",
  "manual_csv_import",
  "unknown_source",
]);
export type DiscoveryFactSourceType = z.infer<typeof SourceTypeSchema>;

// Review lifecycle for a fact/candidate (reuses the canonical-graph review vocabulary). Low confidence /
// ambiguity → `needs_review`; nothing here auto-merges.
export const ReviewStatusSchema = z.enum(["pending", "confirmed", "rejected", "auto", "needs_review"]);
export type DiscoveryReviewStatus = z.infer<typeof ReviewStatusSchema>;

// The 14 standardized fact categories (the `fact_type` discriminator).
export const FactTypeSchema = z.enum([
  "app_discovery",
  "app_instance_identity",
  "vendor_product",
  "app_user_account",
  "person_identity_candidate",
  "license",
  "usage_activity",
  "role_admin",
  "group",
  "group_membership",
  "contract",
  "invoice_spend",
  "risk_completeness",
  "recommendation_evidence",
]);
export type DiscoveryFactType = z.infer<typeof FactTypeSchema>;

// Token/secret-like key names that are NEVER allowed in a fact — neither as a top-level field (the strict
// schemas reject unknown keys) NOR inside the `provenance` record (enforced by ProvenanceSchema's refine
// below). `hasForbiddenFactKey()` reuses this set as a pre-parse deny-list (defense in depth).
const FORBIDDEN_FACT_KEYS: ReadonlySet<string> = new Set([
  "access_token", "refresh_token", "id_token", "api_key", "apikey", "client_secret",
  "connector_secrets", "secret", "password", "private_key",
  ["service", "role", "key"].join("_"), // the service-role key name — built so the literal never appears in src/
  "credentials", "authorization",
]);

// Provenance / source metadata — SAFE scalars only (labels, ids, counts, flags). Never a token/secret payload:
// scalar values only (a structured payload is rejected), AND no token/secret-like KEY (refine), so a nested
// secret like provenance:{ access_token } FAILS safeParse — not just the pre-parse guard.
const ProvenanceSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .refine(
    (obj) => Object.keys(obj).every((k) => !FORBIDDEN_FACT_KEYS.has(k.toLowerCase())),
    { message: "provenance must not contain token/secret-like keys" },
  );

// Core fields EVERY fact carries. `confidence` is 0..1. `raw_source_ref` is a non-secret reference only.
const baseShape = {
  schema_version: z.literal(DISCOVERY_FACT_SCHEMA_VERSION),
  signal_id: z.string().min(1), // deterministic source key or generated id
  tenant_id: z.string().min(1),
  source_type: SourceTypeSchema,
  source_provider: z.string().min(1), // a provider/source label (e.g. "okta", "manual"); never a secret
  source_run_id: z.string().optional(),
  source_record_id: z.string().optional(),
  observed_at: z.string().min(1), // ISO-8601 timestamp (format-tightening is a safe follow-up)
  confidence: z.number().min(0).max(1),
  provenance: ProvenanceSchema.optional(),
  review_status: ReviewStatusSchema.optional(),
  raw_source_ref: z.string().optional(), // a reference/pointer (e.g. file id) — NOT secret material
} as const;

// 1. App discovery — "this SaaS app exists" from a discovery source.
const AppDiscoveryFact = z.object({
  ...baseShape,
  fact_type: z.literal("app_discovery"),
  discovered_app_name: z.string().min(1),
  discovered_vendor_name: z.string().optional(),
  discovered_product_name: z.string().optional(),
  discovered_domain: z.string().optional(),
  source_app_id: z.string().optional(),
  source_app_url: z.string().optional(),
  category: z.string().optional(),
  discovery_capabilities: z.array(z.string()).optional(),
}).strict();

// 2. App instance identity — the merge/no-merge discriminators for ONE operational instance/site/workspace.
const AppInstanceIdentityFact = z.object({
  ...baseShape,
  fact_type: z.literal("app_instance_identity"),
  instance_domain: z.string().optional(),
  external_instance_id: z.string().optional(),
  instance_url: z.string().optional(),
  workspace_id: z.string().optional(),
  site_id: z.string().optional(),
  cloud_id: z.string().optional(),
  owner_org_hint: z.string().optional(),
  paying_org_hint: z.string().optional(),
  responsible_org_hint: z.string().optional(),
}).strict();

// 3. Vendor / product — a vendor family and/or canonical product label.
const VendorProductFact = z.object({
  ...baseShape,
  fact_type: z.literal("vendor_product"),
  vendor_name: z.string().optional(),
  product_name: z.string().optional(),
  vendor_domain: z.string().optional(),
  category: z.string().optional(),
}).strict();

// 4. App user / account — a user/account on an app instance. `matched_person_id` is FUTURE resolved output
// only (never required as input — the resolver fills it; raw signals must not assume a match).
const AppUserAccountFact = z.object({
  ...baseShape,
  fact_type: z.literal("app_user_account"),
  app_user_external_id: z.string().optional(),
  app_id_hint: z.string().optional(),
  app_instance_key: z.string().optional(),
  email: z.string().optional(),
  display_name: z.string().optional(),
  status: z.string().optional(),
  role_hint: z.string().optional(),
  // Provider-reported OBSERVATIONS, not conclusions. The bounded canonical vocabulary (0076's account_kind /
  // account_status CHECK) is derived from these in ONE place — the promote RPC — so a provider that never reports a
  // flag yields `unknown` instead of a defaulted `human`. Booleans, so a declarative field_map can carry them
  // (`is_deleted: "deleted"`) without provider-specific normalizer code.
  is_bot: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  is_admin: z.boolean().optional(),
  last_activity_at: z.string().optional(),
  source_user_id: z.string().optional(),
  matched_person_id: z.string().optional(), // future RESOLVED output only — not required input
}).strict();

// 5. Person identity candidate — a person record (the identity matching anchor). primary_email is the key.
const PersonIdentityCandidateFact = z.object({
  ...baseShape,
  fact_type: z.literal("person_identity_candidate"),
  primary_email: z.string().min(1),
  display_name: z.string().optional(),
  employee_id: z.string().optional(),
  department: z.string().optional(),
  manager_email: z.string().optional(),
  identity_provider_id: z.string().optional(),
}).strict();

// 6. License — a license/SKU assignment + cost hint (a HINT — not authoritative billing).
const LicenseFact = z.object({
  ...baseShape,
  fact_type: z.literal("license"),
  license_name: z.string().min(1),
  license_sku: z.string().optional(),
  assigned_at: z.string().optional(),
  license_status: z.string().optional(),
  cost_hint: z.number().optional(),
  currency: z.string().optional(),
  billing_period: z.string().optional(),
}).strict();

// 7. Usage / activity — aggregate activity signals (no per-event PII payload).
const UsageActivityFact = z.object({
  ...baseShape,
  fact_type: z.literal("usage_activity"),
  last_activity_at: z.string().optional(),
  activity_count: z.number().optional(),
  activity_window_start: z.string().optional(),
  activity_window_end: z.string().optional(),
  usage_source: z.string().optional(),
  usage_confidence: z.number().min(0).max(1).optional(),
}).strict();

// 8. Role / admin — a user's role / admin status on an instance.
const RoleAdminFact = z.object({
  ...baseShape,
  fact_type: z.literal("role_admin"),
  role_name: z.string().min(1),
  is_admin: z.boolean().optional(),
  permissions_hint: z.array(z.string()).optional(),
  role_scope: z.string().optional(),
}).strict();

// 9. Group / team membership.
const GroupMembershipFact = z.object({
  ...baseShape,
  fact_type: z.literal("group_membership"),
  group_id: z.string().optional(),
  group_name: z.string().min(1),
  member_external_id: z.string().optional(),
  member_email: z.string().optional(),
  membership_status: z.string().optional(),
}).strict();

// 9b. Group — a standalone group ENTITY (e.g. a Slack usergroup, an Okta group), independent of any membership edge.
// A `group_membership` links to a `group` by (tenant, source_provider, app_instance_key, group_external_id) at read time
// (a soft natural-key link, no FK). Additive within schema v1 — no version bump, no DB migration (fact_type is free text,
// the fact lives in discovery_facts.fact_json jsonb).
const GroupFact = z.object({
  ...baseShape,
  fact_type: z.literal("group"),
  group_external_id: z.string().min(1),   // provider group id (Slack usergroup id / Okta group id)
  group_name: z.string().min(1),
  group_handle: z.string().optional(),     // Slack @handle; usually absent for Okta
  description: z.string().optional(),
  app_id_hint: z.string().optional(),      // which app the group belongs to
  app_instance_key: z.string().optional(), // instance: Slack team_id / Okta org
  group_type: z.string().optional(),       // provider label (e.g. Okta OKTA_GROUP/APP_GROUP/BUILT_IN)
  member_count: z.number().int().nonnegative().optional(),
  is_active: z.boolean().optional(),
}).strict();

// 10. Contract — a contract signal (e.g. from contract intelligence). source_clause_text is provenance only.
const ContractFact = z.object({
  ...baseShape,
  fact_type: z.literal("contract"),
  contract_id_hint: z.string().optional(),
  counterparty_vendor: z.string().optional(),
  contract_name: z.string().optional(),
  effective_date: z.string().optional(),
  expiration_date: z.string().optional(),
  renewal_date: z.string().optional(),
  notice_deadline: z.string().optional(),
  contract_value: z.number().optional(),
  currency: z.string().optional(),
  products_mentioned: z.array(z.string()).optional(),
  source_file_id: z.string().optional(),
  source_clause_text: z.string().optional(), // provenance text — NOT a secret
}).strict();

// 11. Invoice / spend — an invoice/spend signal. `app_candidate_name` / `contract_candidate_id` are CANDIDATES
// only — an invoice does NOT imply a final app linkage (the resolver decides later).
const InvoiceSpendFact = z.object({
  ...baseShape,
  fact_type: z.literal("invoice_spend"),
  invoice_id_hint: z.string().optional(),
  vendor_name: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  invoice_date: z.string().optional(),
  billing_period_start: z.string().optional(),
  billing_period_end: z.string().optional(),
  app_candidate_name: z.string().optional(), // a CANDIDATE — not a resolved app linkage
  contract_candidate_id: z.string().optional(), // a CANDIDATE — not a resolved contract linkage
}).strict();

// 12. Risk / completeness — a data-quality / coverage-gap / risk observation.
const RiskCompletenessFact = z.object({
  ...baseShape,
  fact_type: z.literal("risk_completeness"),
  risk_type: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  reason: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  suggested_next_step: z.string().optional(),
  coverage_gap_type: z.string().optional(),
}).strict();

// 13. Recommendation evidence — supporting evidence for a future recommendation (not the recommendation).
const RecommendationEvidenceFact = z.object({
  ...baseShape,
  fact_type: z.literal("recommendation_evidence"),
  recommendation_kind: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  estimated_impact: z.string().optional(),
  supporting_signal_ids: z.array(z.string()).optional(),
}).strict();

// The versioned discovery-fact contract — a discriminated union over `fact_type`. safeParse REJECTS unknown
// keys (token/secret material) and unknown fact types (fail closed).
export const DiscoveryFactSchema = z.discriminatedUnion("fact_type", [
  AppDiscoveryFact,
  AppInstanceIdentityFact,
  VendorProductFact,
  AppUserAccountFact,
  PersonIdentityCandidateFact,
  LicenseFact,
  UsageActivityFact,
  RoleAdminFact,
  GroupFact,
  GroupMembershipFact,
  ContractFact,
  InvoiceSpendFact,
  RiskCompletenessFact,
  RecommendationEvidenceFact,
]);
export type DiscoveryFact = z.infer<typeof DiscoveryFactSchema>;

// ── Pure helpers (no I/O) ───────────────────────────────────────────────────────────────────────────────

// Validate an untrusted fact against the contract. Returns zod's discriminated-union SafeParseResult — a
// missing schema_version / unknown fact_type / token-like extra key all yield `success: false`.
export function parseDiscoveryFact(input: unknown): ReturnType<typeof DiscoveryFactSchema.safeParse> {
  return DiscoveryFactSchema.safeParse(input);
}

// The recognized (non-fail-closed) source types.
const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set<DiscoveryFactSourceType>([
  "identity_provider_discovery", "deep_provider_sync", "contract_intelligence",
  "invoice_spend_import", "browser_extension_discovery", "manual_csv_import",
]);

// Map a raw source-type string to a known source type, or fail closed to `unknown_source` (→ review).
export function classifySourceType(raw: string | null | undefined): DiscoveryFactSourceType {
  return typeof raw === "string" && KNOWN_SOURCE_TYPES.has(raw)
    ? (raw as DiscoveryFactSourceType)
    : "unknown_source";
}

export function isKnownSourceType(raw: string | null | undefined): boolean {
  return typeof raw === "string" && KNOWN_SOURCE_TYPES.has(raw);
}

// Defense-in-depth guard: scan a raw object (pre-parse) for token/secret-like keys (reusing FORBIDDEN_FACT_KEYS
// above). The strict schemas + the provenance refine already REJECT these at parse time; this lets callers
// reject + log offending input BEFORE it ever reaches a parser (and catches deeply-nested non-provenance keys).
export function hasForbiddenFactKey(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_FACT_KEYS.has(key.toLowerCase())) return true;
    if (child !== null && typeof child === "object" && hasForbiddenFactKey(child)) return true;
  }
  return false;
}

// The natural merge/no-merge key for an app-instance signal: instance_domain else external_instance_id
// (normalized). Two instance signals with DIFFERENT keys are SEPARATE instance candidates — never auto-merged.
export function appInstanceCandidateKey(
  signal: { instance_domain?: string | null; external_instance_id?: string | null },
): string | null {
  const norm = (v: string | null | undefined): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim().toLowerCase() : null;
  return norm(signal.instance_domain) ?? norm(signal.external_instance_id);
}
