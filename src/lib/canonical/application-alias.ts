// Phase 18A — deterministic canonical application-alias resolution. PURE: no Supabase, no next/headers, no DB, no clock, so it is
// unit-testable in isolation (application-alias.test.ts). The IO half lives in src/lib/data/application-aliases.ts, the same split as
// contract-write.ts (pure) vs contracts.ts (IO).
//
// THE LAYER THIS OWNS. Three facts stay separate, permanently:
//
//   provider identifier          directory_applications.external_id — raw provider evidence, connector-owned (0057)
//   canonical alias judgement    app_aliases — a PRODUCT-SIDE judgement that this identifier IS this product (0024/0026)  ← here
//   application match decision   application_matches — directory application ↔ SaaS app (0075). NOT this phase.
//
// NOTHING HERE AUTHORIZES. Postgres RLS is the only authorization boundary (docs/02). These helpers shape input, decide what counts
// as deterministic evidence, and classify an outcome. They never read a tenant id from caller input — there is no such parameter.
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

// Alias types a PRODUCT-SIDE DECLARATION may currently create. Narrower than the deterministic set on purpose: an alias type is
// enabled only when a real current source field carries those semantics, never because the enum contains the word.
//
// Today the directory side (directory_applications, 0057) exposes exactly ONE such field — `external_id`, the immutable provider
// application id — so `provider_app_id` is the only declarable type. `sso_app_id`, `oauth_client_id`, `external_instance_id` and
// `instance_domain` stay disabled: no current directory column carries them. (`apps.instance_domain` / `apps.external_instance_id`
// exist on the SaaS side, but a declaration's source here is a directory application, and both columns are unpopulated anyway.)
// Adding a type to this list means naming the source field it reads from.
export const DECLARABLE_ALIAS_TYPES: readonly AliasType[] = ["provider_app_id"];

// A canonical alias is a JUDGEMENT, and only a settled judgement resolves. 'pending' is a proposal nobody has accepted and
// 'rejected' is a human saying "these are not the same product" — neither is canonical truth, so both resolve to UNRESOLVED
// rather than being quietly treated as a match. 'auto' is a deterministic writer's own settled conclusion (0024 vocabulary).
export const RESOLVING_REVIEW_STATUSES = ["confirmed", "auto"] as const;

// The subset of an app_aliases row this module reasons about. Structural, so the pure layer does not depend on the generated DB
// types — a column rename surfaces in the IO layer where the query lives, not here.
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
export function isDeclarableAliasType(value: string): boolean {
  return (DECLARABLE_ALIAS_TYPES as readonly string[]).includes(value);
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
 */
export function resolveCanonicalAlias(aliasType: string, row: CanonicalAliasRow | null): AliasResolution {
  if (!isDeterministicAliasType(aliasType)) return { outcome: "unsupported", aliasType };
  if (row == null) return { outcome: "unresolved" };
  if (!(RESOLVING_REVIEW_STATUSES as readonly string[]).includes(row.reviewStatus)) return { outcome: "unresolved" };
  return { outcome: "resolved", appProductId: row.appProductId };
}

// What a declaration should do about the row that is already there. `insert` is the only branch that writes.
export type DeclarationPlan =
  | { readonly action: "insert" }
  | { readonly action: "unchanged" }
  | { readonly action: "conflict"; readonly reason: "different_product" | "rejected" };

/**
 * Decide a declaration against the existing alias, if any. Human decisions outrank the declaration:
 *
 *   no row                        → insert
 *   row → a DIFFERENT product     → conflict. Last-write-wins is not a canonical identity policy; re-pointing an identifier at
 *                                   another product is a change of judgement and needs an explicit review action, not a re-submit.
 *   row rejected                  → conflict, even for the same product. Somebody decided these are not the same thing.
 *   row → the SAME product        → unchanged. Re-declaring is a no-op success, which is what makes the action idempotent.
 *
 * A 'pending' row for the same product is left exactly as it is rather than being promoted to 'confirmed'. Nothing writes
 * 'pending' aliases today; the promotion path belongs to whichever phase introduces a proposer, and inventing it here would be a
 * write with no caller.
 */
export function planDeclaration(existing: CanonicalAliasRow | null, targetAppProductId: string): DeclarationPlan {
  if (existing == null) return { action: "insert" };
  if (existing.appProductId !== targetAppProductId) return { action: "conflict", reason: "different_product" };
  if (existing.reviewStatus === "rejected") return { action: "conflict", reason: "rejected" };
  return { action: "unchanged" };
}

// A directory application is eligible to SOURCE a new canonical declaration only while the provider still reports it. Provider
// freshness and canonical judgement are separate facts, and the asymmetry is deliberate: a stale row must not mint NEW canonical
// truth, but an already-confirmed alias keeps resolving forever regardless of its source's sync_status — resolveCanonicalAlias
// never looks at the directory side at all.
export function isEligibleDeclarationSource(syncStatus: string): boolean {
  return syncStatus === "current";
}

// Map a Postgres error code to a caller-safe label. Never reveals whether a cross-tenant row exists: RLS and the same-tenant
// composite FKs (app_aliases_product_same_tenant / app_aliases_app_same_tenant) both surface as `not_allowed`.
export function classifyAliasWriteError(code: string | null | undefined): "not_allowed" | "conflict" | "query_failed" {
  switch (code) {
    case "42501": // insufficient_privilege — the RLS WITH CHECK denied the write (member without editor+)
    case "23514": // check_violation — alias_type / review_status CHECK rejected the row
    case "23503": // foreign_key_violation — app_product_id absent, or in another tenant (composite FK)
      return "not_allowed";
    case "23505": // unique_violation — the 0026 natural key; a concurrent writer took (tenant, alias_type, alias_value)
      return "conflict";
    default:
      return "query_failed";
  }
}
