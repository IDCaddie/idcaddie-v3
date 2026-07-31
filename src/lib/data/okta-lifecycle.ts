// The Okta connector lifecycle vocabulary — PURE, no server import, so the client marketplace card can render real
// persisted state without pulling `@/lib/supabase/server` (and therefore `next/headers`) into the browser bundle.
//
// This was split out of okta-connector-status.ts in Phase 1 for exactly that reason; that module re-exports everything
// here, so existing server-side imports are unchanged.

// The lifecycle the CUSTOMER sees. Deliberately more explicit than the database's `connection_state`, because "configured" and
// "verified" are the two states most easily misread as "connected", and because verification and discovery are separate stages
// that a single enum value flattens.
export type OktaLifecycle =
  | "configuration_saved"
  | "verification_pending"
  | "verifying"
  | "verified"
  | "initial_discovery_pending"
  | "discovering"
  | "discovered"
  | "failed";

export const OKTA_LIFECYCLE_LABEL: Record<OktaLifecycle, string> = {
  configuration_saved: "Configuration saved",
  verification_pending: "Verification pending",
  verifying: "Verifying",
  verified: "Verified",
  initial_discovery_pending: "Initial discovery pending",
  discovering: "Discovering",
  discovered: "Discovered",
  failed: "Failed",
};

// Map the database's connection_state + validation_status onto the customer lifecycle.
//
// Verification and discovery are SEPARATE stages with separate evidence, so this reads both rather than trusting one field:
// `validation_status` is the authority on verification, `connection_state` on discovery progress. A failed validation wins over
// a hopeful connection_state — the failure is the thing the customer needs to act on.
export function deriveLifecycle(connectionState: string | null, validationStatus: string | null): OktaLifecycle {
  if (validationStatus === "failed" || connectionState === "error" || connectionState === "partial_failure") return "failed";
  if (connectionState === "discovered") return "discovered";
  if (connectionState === "discovering") return "discovering";
  if (connectionState === "discovery_pending") return "initial_discovery_pending";
  if (validationStatus === "succeeded" || connectionState === "verified") return "verified";
  if (validationStatus === "pending" || connectionState === "verification_pending") return "verifying";
  // `configured` with nothing validated yet: the configuration exists and verification has not started.
  if (connectionState === "configured") return "verification_pending";
  return "configuration_saved";
}

// Verification is the gate everything downstream depends on, so it is derived ONCE here rather than re-tested at each
// call site with a slightly different list of lifecycles.
export function isVerified(l: OktaLifecycle): boolean {
  return l === "verified" || l === "initial_discovery_pending" || l === "discovering" || l === "discovered";
}

// A client id is NON-secret (the customer typed it, and it is visible in their Okta console) but there is no reason to render it
// in full on a shared screen. Keep the shape recognisable so they can confirm it is the right app.
export function maskClientId(clientId: string): string {
  if (clientId.length <= 8) return clientId;
  return `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
}
