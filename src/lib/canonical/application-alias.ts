// Phase 18A — deterministic canonical application-alias RESOLUTION. PURE: no Supabase, no next/headers, no DB, no clock, so it is
// unit-testable in isolation (application-alias.test.ts). The IO half lives in src/lib/data/application-aliases.ts, the same split
// as contract-write.ts (pure) vs contracts.ts (IO).
//
// READ-ONLY. This layer CONSUMES canonical aliases; it does not create them. There is currently NO product-side path that
// declares one — see docs/79. So the seam
//
//     provider identifier → app_aliases → canonical product
//
// is usable the moment an alias exists, and today `app_aliases` is empty. This phase does not populate the bridge.
//
// THE LAYER THIS OWNS. Three facts stay separate, permanently:
//
//   provider identifier          directory_applications.external_id — raw provider evidence, connector-owned (0057)
//   canonical alias judgement    app_aliases — a PRODUCT-SIDE judgement that this identifier IS this product (0024/0026)  ← here
//   application match decision   application_matches — directory application ↔ SaaS app (0075). NOT this phase.
//
// NOTHING HERE AUTHORIZES. Postgres RLS is the only authorization boundary (docs/02); the 0024 "members read app_aliases" policy
// scopes every read, and org_rls_test.sql T46 proves that isolation functionally against a real database.
//
// WHY NO NAME MATCHING, EVER. `app_aliases.alias_type` includes 'name', and a name is display metadata, not identity: "Slack",
// "Slack Technologies" and "Slack Enterprise Grid" are three strings that may be one product, three products, or two vendors. A
// resolver that accepts a name produces confident wrong answers, so 'name' is excluded structurally below rather than by
// convention — see DETERMINISTIC_ALIAS_TYPES.

// The alias_type vocabulary as the 0024 CHECK constraint defines it. Kept here so a drift between code and schema shows up as a
// failing test rather than a silently unreachable branch.
export const ALIAS_TYPES = [
  "domain", "instance_domain", "external_instance_id", "provider_app_id", "oauth_client_id", "sso_app_id", "name",
] as const;
export type AliasType = (typeof ALIAS_TYPES)[number];

// Alias types that may be resolved deterministically: every type EXCEPT 'name'. Each of these is an exact identifier issued by a
// system — a provider application id, an OAuth client id, a workspace/instance id, a domain. Two rows carrying the same value are
// the same thing. 'name' is the sole excluded member and its exclusion is the point of this module.
export const DETERMINISTIC_ALIAS_TYPES: readonly AliasType[] = ALIAS_TYPES.filter((t) => t !== "name");

// A canonical alias is a JUDGEMENT, and only a settled judgement resolves. ONLY 'confirmed' resolves.
//
// 'pending' is a proposal nobody has accepted and 'rejected' is a human saying "these are not the same product" — neither is
// canonical truth. 'auto' is EXCLUDED for a different and more important reason: the 0024/0025 CHECK constraints admit it, but
// nothing in this repository defines what it means, nothing writes it, and the only implemented review lifecycle
// (sync-review-actions.ts, over the sibling discovery_facts table) transitions pending → confirmed | rejected and never mentions
// it. Reading an undefined status as accepted canonical truth is exactly the "proposal silently becomes fact" failure this layer
// exists to prevent. If a future deterministic writer wants auto-confirmed aliases, that phase adds 'auto' here together with a
// documented meaning — deciding it now, on no evidence, is the mistake.
export const RESOLVING_REVIEW_STATUSES = ["confirmed"] as const;

// The subset of an app_aliases row this module reasons about. Structural, so the pure layer does not depend on the generated DB
// types — a column rename surfaces in the IO layer where the query lives, not here. Note what is ABSENT: no name, no label, no
// directory-side field, and nothing about the source's freshness.
export type CanonicalAliasRow = {
  readonly appProductId: string;
  readonly reviewStatus: string;
};

export type AliasResolution =
  | { readonly outcome: "resolved"; readonly appProductId: string }
  | { readonly outcome: "unresolved" }
  | { readonly outcome: "unsupported"; readonly aliasType: string };

export function isAliasType(value: string): value is AliasType {
  return (ALIAS_TYPES as readonly string[]).includes(value);
}
export function isDeterministicAliasType(value: string): boolean {
  return (DETERMINISTIC_ALIAS_TYPES as readonly string[]).includes(value);
}

// Trim only. Case is NOT folded and nothing else is rewritten: an Okta application id (`0oa1b2c3…`) and an OAuth client id are
// case-sensitive opaque strings, so lowercasing them would invent a different identifier. Surrounding whitespace is never part of
// a provider identifier, so trimming is safe and makes a copy-pasted value idempotent against the 0026 natural key
// UNIQUE(tenant_id, alias_type, alias_value).
export function normalizeAliasValue(value: string): string {
  return value.trim();
}

/**
 * Resolve a deterministic alias to its canonical product.
 *
 * `row` is the at-most-one app_aliases row for (tenant, alias_type, alias_value) — at most one because of the 0026 natural key.
 * That uniqueness is why this returns a single answer rather than a candidate list: app_aliases holds a settled canonical
 * judgement, NOT competing match candidates. Ambiguity is represented by the ABSENCE of a row, never by several rows.
 *
 * A resolution says "this identifier IS this product". It does NOT say a directory application has been matched to a SaaS app —
 * that decision belongs to application_matches (0075) and is still unbuilt.
 */
export function resolveCanonicalAlias(aliasType: string, row: CanonicalAliasRow | null): AliasResolution {
  if (!isDeterministicAliasType(aliasType)) return { outcome: "unsupported", aliasType };
  if (row == null) return { outcome: "unresolved" };
  if (!(RESOLVING_REVIEW_STATUSES as readonly string[]).includes(row.reviewStatus)) return { outcome: "unresolved" };
  return { outcome: "resolved", appProductId: row.appProductId };
}
