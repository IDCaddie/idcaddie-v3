// Phase 18B0 — the PURE decisions behind linking an operational `apps` row to its canonical `app_products` identity.
//
// PURE: no Supabase, no next/headers, no DB, no clock. The IO half is src/lib/data/app-canonicalization.ts, the same split as
// application-alias.ts (pure) vs application-aliases.ts (IO).
//
// ══ WHAT THIS UNBLOCKS, AND WHY IT NEEDED NOTHING NEW ═══════════════════════════════════════════════════════════════════════
// The canonical chain was already complete in SCHEMA and empty in PRACTICE:
//
//     app_products                      canonical product identity ("Slack")          — 0024, ZERO writers before this phase
//     apps.canonical_app_id             nullable FK, same-tenant composite (0024)     — written by NOTHING
//     apps.external_instance_id         the provider's instance id, UNIQUE per tenant — written by connector sync (0036)
//     app_aliases                       the confirmed identifier -> product judgement — 0024/0026
//
// `resolution.ts` says it outright: "the resolver does not exist yet and nothing populates apps.canonical_app_id yet." That is
// the whole defect. No column, constraint or policy is missing — a WRITER is. So this phase adds no migration.
//
// ══ THE ONE IDENTIFIER THIS PHASE TRUSTS ════════════════════════════════════════════════════════════════════════════════════
// `external_instance_id` and nothing else. 0024's alias vocabulary also admits `instance_domain`, `domain`, `oauth_client_id`
// and `sso_app_id`, and it would be one line to accept them — but NOTHING IN THIS REPOSITORY POPULATES THEM. Enabling an alias
// class because an enum permits it creates a branch that can never be exercised and a claim that can never be checked. Connector
// sync writes `external_instance_id` (a Slack workspace team_id) under a UNIQUE(tenant_id, external_instance_id) key, so it is
// the one identifier that is both deterministic AND real. A later phase that starts populating another class adds it here, with
// a test that reaches it.
//
// ══ NAMES ARE NOT IDENTITY ══════════════════════════════════════════════════════════════════════════════════════════════════
// Nothing below compares an app's name to a product's name, and no resolution path reads a name at all. "Slack", "Slack
// Technologies" and "Slack Enterprise Grid" may be one product, three products, or two vendors, and a resolver that guesses
// produces confident wrong answers. `normalizeProductName` exists ONLY to fill `app_products.normalized_name`, which is that
// table's own per-tenant DEDUP key for a human-entered label — it never decides that an app and a product are the same thing.

/**
 * The only alias class an `apps` row can currently supply.
 *
 * Deliberately a single value rather than a list: a list invites "just add another" without asking whether anything writes it.
 */
export const APP_IDENTITY_ALIAS_TYPE = "external_instance_id" as const;

export type AppIdentityRow = {
  readonly id: string;
  readonly externalInstanceId: string | null;
  readonly canonicalAppId: string | null;
};

/**
 * The deterministic identifier this app can be canonicalized by, or null when it has none.
 *
 * A blank or whitespace-only value is NOT an identifier. Trim only — an instance id is an opaque, case-sensitive string issued
 * by a provider, so folding case would invent a different identifier (application-alias.ts makes the same choice for the same
 * reason, and the 0026 natural key is what both are protecting).
 */
export function appIdentifier(app: Pick<AppIdentityRow, "externalInstanceId">): string | null {
  const trimmed = (app.externalInstanceId ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `app_products.normalized_name` — that table's per-tenant dedup key, NOT an identity signal.
 *
 * Used only when a human creates a product, so that entering "Slack" twice collides on
 * UNIQUE(tenant_id, vendor_id, normalized_name) instead of silently creating two canonical products. It is never compared to
 * anything on the `apps` side.
 */
export function normalizeProductName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── the link decision ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type LinkDecision =
  | { readonly action: "link"; readonly appProductId: string }
  // Already pointing at this product. Re-running the resolver is a no-op, not an error.
  | { readonly action: "already_linked"; readonly appProductId: string }
  // Pointing at a DIFFERENT product. Never overwritten here: re-canonicalizing an app is a human decision about identity, and
  // 0024 is explicit that the resolver "unmerges by repointing aliases/canonical_app_id" — a deliberate act, not a side effect
  // of a background resolve.
  | { readonly action: "conflict"; readonly currentAppProductId: string; readonly resolvedAppProductId: string }
  // No confirmed alias for this app's identifier — or the app has no deterministic identifier at all. UNRESOLVED IS NOT WRONG:
  // it is the honest state for an app nobody has declared canonical identity for.
  | { readonly action: "unresolved"; readonly reason: "no_identifier" | "no_confirmed_alias" };

/**
 * Decide what canonicalizing one app should do.
 *
 * `resolvedAppProductId` is the output of the Phase 18A1 resolver (`resolveCanonicalAlias`), which admits ONLY `confirmed`
 * aliases and structurally refuses `name`. Passing null here therefore covers pending, rejected, `auto`, absent, and
 * non-deterministic alias types alike — every one of which must leave the app unresolved rather than linked.
 */
export function decideCanonicalLink(input: {
  readonly app: AppIdentityRow;
  readonly resolvedAppProductId: string | null;
}): LinkDecision {
  if (appIdentifier(input.app) === null) return { action: "unresolved", reason: "no_identifier" };
  if (input.resolvedAppProductId === null) return { action: "unresolved", reason: "no_confirmed_alias" };

  const current = input.app.canonicalAppId;
  if (current === null) return { action: "link", appProductId: input.resolvedAppProductId };
  if (current === input.resolvedAppProductId) return { action: "already_linked", appProductId: current };
  return { action: "conflict", currentAppProductId: current, resolvedAppProductId: input.resolvedAppProductId };
}

// ── the bounded result vocabulary of the IO layer ────────────────────────────────────────────────────────────────────────────
// A caller may render or log any of these; none can carry SQL, a row, a provider payload or a stack.
export const CANONICALIZATION_STATUSES = [
  "linked", "already_linked", "conflict", "no_identifier", "no_confirmed_alias",
] as const;
export type CanonicalizationStatus = (typeof CANONICALIZATION_STATUSES)[number];

export const decisionToStatus = (d: LinkDecision): CanonicalizationStatus =>
  d.action === "link" ? "linked"
    : d.action === "already_linked" ? "already_linked"
      : d.action === "conflict" ? "conflict"
        : d.reason;
