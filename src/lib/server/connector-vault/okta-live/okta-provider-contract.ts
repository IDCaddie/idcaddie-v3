// P5E18a — the typed Okta LIVE-CONNECTION provider contract (DORMANT). PURE + server-only. Declares only the customer-safe,
// read-only pilot capabilities + the exact intended OAuth scope, and the PROVIDER LIFECYCLE state — which is deliberately SEPARATE
// from any UI display status (a "Preview" label must never grant execution). Okta stays `certificationOnly` in this phase: nothing
// here connects, exchanges a code, reads a secret, or calls Okta. No network, no DB, no token, no fetch, no process.env.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-provider-contract is server-only and must not be imported in client code");
}

// The canonical provider id — MUST be identical everywhere (registry, credential-reference JOIN, control plane). A drifted label
// (e.g. "okta_oauth") silently fails closed at the DB JOIN; pin it here so every Okta module imports the one constant.
export const OKTA_PROVIDER_ID = "okta" as const;

// Okta client ids (Web App or API Services) are opaque, prefixed `0oa` + a bounded safe charset (NOT a UUID). Validated by SHAPE
// only — a NON-SECRET value. (Moved here from the removed Model-A okta-authorize-url so it survives the browser-OAuth cleanup.)
const OKTA_CLIENT_ID_RE = /^0oa[a-zA-Z0-9]{10,40}$/;
export function isValidOktaClientId(v: unknown): v is string {
  return typeof v === "string" && OKTA_CLIENT_ID_RE.test(v);
}

// Customer-safe, READ-ONLY pilot capabilities. These are the ONLY things a future Okta connection may read. `read_groups` (Phase 6)
// is directory-group discovery ONLY — group entities, NO memberships, NO applications, NO assignments, NO group-derived access.
export const OKTA_PILOT_CAPABILITIES = Object.freeze(["read_users", "read_account_status", "read_basic_profile", "read_groups"] as const);
export type OktaPilotCapability = (typeof OKTA_PILOT_CAPABILITIES)[number];

// The EXACT intended OAuth scope set — least privilege. A live authorize/exchange must request EXACTLY this set (see
// scopesExactlyApproved); a subset or superset is rejected. All three are READ-ONLY:
//   okta.users.read   — directory identities
//   okta.groups.read  — group ENTITIES (Phase 6). Group WRITES stay prohibited.
//   okta.apps.read    — application ENTITIES + their assignment sub-resources (Phase 9/11/12). Application WRITES stay prohibited.
//
// O1B — this is the runtime mirror of `contracts/okta-provider-contract.v1.json` (contract_version 1.0.0), the artifact checked into
// idcaddie-connector-runner at the same relative path. `okta-contract-consistency.test.ts` fails closed if the two disagree.
//
// Before O1B this constant held only the first two scopes AND okta.apps.read was listed as PROHIBITED below — so this validator
// actively rejected the scope the connector-runner requires for application and assignment discovery. A customer granting the
// correct three scopes would have been refused at the config gate. Do NOT broaden further (memberships beyond the assignment
// sub-resources, or ANY write scope) without another separately-authorized capability phase.
export const OKTA_APPROVED_SCOPES = Object.freeze(["okta.users.read", "okta.groups.read", "okta.apps.read"] as const);
export type OktaApprovedScope = (typeof OKTA_APPROVED_SCOPES)[number];

// Explicitly PROHIBITED scope families — never requested, and asserted-absent by tests. These are capabilities the pilot must
// never obtain (write, admin, password, MFA, lifecycle, logs, group WRITES, application WRITES).
//
// SUPERSEDED (O1B): okta.apps.read was previously listed here. It is now APPROVED — read-only application entities and their
// assignment sub-resources. okta.apps.manage (application writes) remains prohibited, which is the distinction that was conflated.
export const OKTA_PROHIBITED_SCOPES = Object.freeze([
  "okta.users.manage", "okta.users.write", "okta.groups.manage", "okta.groups.write", "okta.apps.manage", "okta.apps.write",
  "okta.logs.read", "okta.factors.read", "okta.factors.manage", "okta.roles.manage", "okta.schemas.manage",
  "okta.policies.manage", "okta.users.lifecycle.manage", "okta.users.credentials.manage",
] as const);

// Human-readable statement of what the pilot MUST NOT do (used by docs/tests; never a live capability).
export const OKTA_PROHIBITED_CAPABILITIES = Object.freeze([
  "password_access", "mfa_administration", "password_reset", "application_administration", "group_modification",
  "user_lifecycle_writes", "system_log_access", "any_write_scope",
] as const);

// PROVIDER LIFECYCLE — separate from UI status. certificationOnly (dormant; the ONLY value this phase), pilotReady (a future
// authorized pilot may connect), enabled (fully live). This is the authority for execution decisions — NOT the UI "Preview" label.
export type OktaProviderLifecycle = "certificationOnly" | "pilotReady" | "enabled";

// The current lifecycle. Pinned to certificationOnly for P5E18a. Changing this is an explicit, separately-GO'd governance action.
export const OKTA_LIFECYCLE: OktaProviderLifecycle = "certificationOnly";

// A future authorized pilot connection is permitted only at pilotReady/enabled — NEVER at certificationOnly.
export function oktaLifecyclePermitsPilotConnection(state: OktaProviderLifecycle): boolean {
  return state === "pilotReady" || state === "enabled";
}

// Execution (a real sync) is permitted only when fully enabled — pilotReady still cannot run without the separate first-sync
// authorization + control-plane gates. certificationOnly can NEVER execute.
export function oktaLifecyclePermitsExecution(state: OktaProviderLifecycle): boolean {
  return state === "enabled";
}

// EXACT-set scope enforcement: the requested scopes must equal OKTA_APPROVED_SCOPES as a SET — no missing, no extra, no prohibited,
// no duplicates. ORDERING IS IRRELEVANT (a customer's Okta console lists scopes in its own order, and a granted-scope string from a
// token response is whitespace-separated in arbitrary order — neither may change the verdict). Returns a typed result; never throws.
// This is the security gate, not the UI.
//
// O1B — diagnostics are now specific instead of one catch-all `not_exact_approved_set`, so an operator can tell "the customer
// forgot okta.apps.read" from "the customer granted a write scope". They carry ONLY scope NAMES: never a token, never a raw OAuth
// response, never a client assertion.
export type ScopeCheck =
  | { ok: true }
  | { ok: false; reason: "empty" | "malformed" | "duplicate" | "prohibited" }
  | { ok: false; reason: "missing_required_scope"; missing: readonly string[] }
  | { ok: false; reason: "unknown_scope"; extra: readonly string[] };

export function scopesExactlyApproved(requested: readonly string[] | null | undefined): ScopeCheck {
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, reason: "empty" };
  const seen = new Set<string>();
  for (const s of requested) {
    if (typeof s !== "string" || s.trim().length === 0) return { ok: false, reason: "empty" };
    // Normalize ONLY surrounding whitespace and case. Okta scope names are lower-case dotted identifiers, so a leading space or a
    // console copy-paste in mixed case is a formatting variant. An INNER space (or any other whitespace) makes the name malformed
    // — reject it rather than silently repairing a value that was never a real scope.
    const n = s.trim().toLowerCase();
    if (/\s/.test(n)) return { ok: false, reason: "malformed" };
    // A duplicate is REJECTED, not de-duplicated: the caller is asserting what a provider granted, and a repeated entry means the
    // caller's own view is inconsistent. Normalization happens first, so "okta.users.read" and " Okta.Users.Read " collide here.
    if (seen.has(n)) return { ok: false, reason: "duplicate" };
    seen.add(n);
  }
  // Prohibited (write/admin/lifecycle/logs/factors) is checked BEFORE the set comparison so escalation reports as `prohibited`
  // rather than as a mere unknown extra. Both the explicit list and the write-verb families are refused.
  for (const s of seen) {
    if ((OKTA_PROHIBITED_SCOPES as readonly string[]).includes(s)) return { ok: false, reason: "prohibited" };
    if (s.endsWith(".manage") || s.endsWith(".write")) return { ok: false, reason: "prohibited" };
  }
  const extra = [...seen].filter((s) => !(OKTA_APPROVED_SCOPES as readonly string[]).includes(s)).sort();
  if (extra.length > 0) return { ok: false, reason: "unknown_scope", extra };
  const missing = (OKTA_APPROVED_SCOPES as readonly string[]).filter((s) => !seen.has(s));
  if (missing.length > 0) return { ok: false, reason: "missing_required_scope", missing };
  return { ok: true };
}
