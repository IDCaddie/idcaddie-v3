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

// Customer-safe, READ-ONLY pilot capabilities. These are the ONLY things a future Okta connection may read.
export const OKTA_PILOT_CAPABILITIES = Object.freeze(["read_users", "read_account_status", "read_basic_profile"] as const);
export type OktaPilotCapability = (typeof OKTA_PILOT_CAPABILITIES)[number];

// The EXACT intended OAuth scope set — least privilege. A live authorize/exchange must request EXACTLY this set (see
// scopesExactlyApproved); a subset or superset is rejected. Do NOT broaden without a separately-authorized capability phase.
export const OKTA_APPROVED_SCOPES = Object.freeze(["okta.users.read"] as const);
export type OktaApprovedScope = (typeof OKTA_APPROVED_SCOPES)[number];

// Explicitly PROHIBITED scope families — never requested, and asserted-absent by tests. These are capabilities the pilot must
// never obtain (write, admin, password, MFA, lifecycle, logs, groups, apps).
export const OKTA_PROHIBITED_SCOPES = Object.freeze([
  "okta.users.manage", "okta.users.write", "okta.groups.manage", "okta.groups.read", "okta.apps.manage", "okta.apps.read",
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

// EXACT-set scope enforcement (Phase 6): the requested scopes must equal OKTA_APPROVED_SCOPES exactly — no missing, no extra, no
// prohibited, no duplicates. Returns a typed result; never throws. This is the security gate, not the UI.
export type ScopeCheck = { ok: true } | { ok: false; reason: "empty" | "duplicate" | "prohibited" | "not_exact_approved_set" };
export function scopesExactlyApproved(requested: readonly string[] | null | undefined): ScopeCheck {
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, reason: "empty" };
  const seen = new Set<string>();
  for (const s of requested) {
    if (typeof s !== "string" || s.length === 0) return { ok: false, reason: "empty" };
    if (seen.has(s)) return { ok: false, reason: "duplicate" };
    seen.add(s);
    if ((OKTA_PROHIBITED_SCOPES as readonly string[]).includes(s)) return { ok: false, reason: "prohibited" };
  }
  // exact set equality with the approved list
  if (seen.size !== OKTA_APPROVED_SCOPES.length) return { ok: false, reason: "not_exact_approved_set" };
  for (const s of OKTA_APPROVED_SCOPES) if (!seen.has(s)) return { ok: false, reason: "not_exact_approved_set" };
  return { ok: true };
}
