// P5E18a Phase 14 — CLIENT-SAFE customer-facing vocabulary for the (future) real Okta connection states. PURE data + label maps:
// NO server import, NO okta-live import, NO secret/governance term. It exists so the UI can render the eventual real-connection
// states without leaking internal wording — while the REAL connection stays UNAVAILABLE and the UI keeps showing Okta as "Preview".
//
// The real hosted OAuth connection is gated server-side (certificationOnly). This flag is the CLIENT-SAFE separation between the
// simulated PREVIEW walkthrough (which stays working) and real-connection availability (which is false). The UI must NOT expose a
// working real OAuth button while this is false — and it is pinned false in P5E18a.
export const REAL_OKTA_CONNECTION_AVAILABLE = false as const;

// The future customer-facing connection states — plain language only, never an internal term (no certificationOnly / Phase C /
// RISK-007 / ECS / credential reference / promotion gate).
export type OktaCustomerConnectionState =
  | "preview"
  | "real_not_available"
  | "authorization_expired"
  | "needs_attention"
  | "reconnect_required"
  | "ready_for_supervised_first_sync"
  | "first_sync_awaiting_approval";

const LABELS: Record<OktaCustomerConnectionState, string> = {
  preview: "Preview",
  real_not_available: "Real connection not yet available",
  authorization_expired: "Authorization expired",
  needs_attention: "Connection needs attention",
  reconnect_required: "Reconnect required",
  ready_for_supervised_first_sync: "Ready for supervised first sync",
  first_sync_awaiting_approval: "First sync awaiting approval",
};

export type OktaCustomerStateTone = "neutral" | "attention" | "success";
const TONES: Record<OktaCustomerConnectionState, OktaCustomerStateTone> = {
  preview: "neutral",
  real_not_available: "neutral",
  authorization_expired: "attention",
  needs_attention: "attention",
  reconnect_required: "attention",
  ready_for_supervised_first_sync: "success",
  first_sync_awaiting_approval: "attention",
};

export function oktaCustomerStateLabel(state: OktaCustomerConnectionState): string {
  return LABELS[state];
}
export function oktaCustomerStateTone(state: OktaCustomerConnectionState): OktaCustomerStateTone {
  return TONES[state];
}

// While the real connection is unavailable, the customer-facing status for Okta stays "Preview" — the label the marketplace/detail
// already show. (When a future phase enables the real path, the UI switches to the states above.)
export function oktaDisplayState(): OktaCustomerConnectionState {
  return REAL_OKTA_CONNECTION_AVAILABLE ? "ready_for_supervised_first_sync" : "preview";
}
