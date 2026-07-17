// P5E18a — the CODE representation of the standing governance gates for a hosted Okta OAuth connection. PURE, server-only. These
// booleans are the single source of truth every Okta gate (connect, first-sync, execution eligibility) consults; they are PINNED
// to the blocked/dormant state and changing any of them is an explicit, separately-GO'd governance action (NOT part of P5E18a).
//
//   phaseCUnblocked   — false: Phase C remains BLOCKED.
//   risk007Closed     — false: RISK-007 remains OPEN.
//   hostedOAuthEnabled— false: no hosted Okta OAuth environment is enabled.
//
// So `governancePermitsHostedOkta()` returns false today, and every consumer fails closed independently of any other gate.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-governance-gate is server-only and must not be imported in client code");
}

export type OktaGovernanceState = {
  readonly phaseCUnblocked: boolean;
  readonly risk007Closed: boolean;
  readonly hostedOAuthEnabled: boolean;
};

// The pinned dormant governance state. Deeply frozen so no caller can mutate it.
export const OKTA_GOVERNANCE: OktaGovernanceState = Object.freeze({
  phaseCUnblocked: false,
  risk007Closed: false,
  hostedOAuthEnabled: false,
});

// Hosted Okta OAuth is permitted ONLY when Phase C is unblocked AND RISK-007 is closed AND the hosted OAuth environment is
// enabled. All three are false today → returns false (fail closed).
export function governancePermitsHostedOkta(g: OktaGovernanceState = OKTA_GOVERNANCE): boolean {
  return g.phaseCUnblocked === true && g.risk007Closed === true && g.hostedOAuthEnabled === true;
}
