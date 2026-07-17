import { describe, it, expect } from "vitest";
import { evaluateOktaConnectGate, type OktaConnectGateInput, type OktaConnectGateDeps } from "./okta-connect-gate";

// P5E18a Phase 5/19 — the dormant connect gate: fails closed by default, and EVERY gate fails independently.

const passInput: OktaConnectGateInput = {
  authenticated: true,
  hasOrgMembership: true,
  role: "admin",
  provider: "okta",
  organizationId: "org-1",
  rawOrganization: "acme.okta.com",
  requestedScopes: ["okta.users.read"],
  callbackPath: "/connectors/oauth/okta/callback",
  returnRoute: "/connectors/okta/status",
};
// Deps that would let ALL gates pass — only constructible by explicitly overriding lifecycle + governance + flags in a test.
const passDeps: OktaConnectGateDeps = {
  lifecycle: "enabled",
  governance: { phaseCUnblocked: true, risk007Closed: true, hostedOAuthEnabled: true },
  orgFeatureFlagEnabled: true,
  environmentPermitsHostedOAuth: true,
};

describe("evaluateOktaConnectGate — dormancy + independent gates", () => {
  it("with default deps (certificationOnly + blocked governance) it FAILS CLOSED", () => {
    const r = evaluateOktaConnectGate(passInput, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockedReason).toBe("lifecycle_not_pilot_ready");
  });

  it("ONLY passes when lifecycle + governance + flags are all explicitly overridden (proves the gate is the sole barrier)", () => {
    const r = evaluateOktaConnectGate(passInput, passDeps);
    expect(r.ok).toBe(true);
  });

  // Each gate, flipped one at a time from the fully-passing baseline.
  const cases: [Partial<OktaConnectGateInput>, Partial<OktaConnectGateDeps>, string][] = [
    [{ authenticated: false }, {}, "not_authenticated"],
    [{ hasOrgMembership: false }, {}, "no_membership"],
    [{ role: "member" }, {}, "insufficient_role"],
    [{ provider: "slack" }, {}, "provider_not_okta"],
    [{}, { lifecycle: "certificationOnly" }, "lifecycle_not_pilot_ready"],
    [{}, { orgFeatureFlagEnabled: false }, "org_feature_flag_disabled"],
    [{}, { environmentPermitsHostedOAuth: false }, "environment_disallows_hosted_oauth"],
    [{}, { governance: { phaseCUnblocked: false, risk007Closed: true, hostedOAuthEnabled: true } }, "governance_blocked"],
    [{ rawOrganization: "evil.com" }, {}, "invalid_organization"],
    [{ rawOrganization: "169.254.169.254" }, {}, "invalid_organization"],
    [{ requestedScopes: ["okta.groups.read"] }, {}, "scope_not_exact"],
    [{ callbackPath: "/connectors/oauth/evil" }, {}, "invalid_callback_route"],
    [{ returnRoute: "https://evil.com" }, {}, "unsafe_return_route"],
  ];
  for (const [inputOverride, depsOverride, reason] of cases) {
    it(`independently blocks: ${reason}`, () => {
      const r = evaluateOktaConnectGate({ ...passInput, ...inputOverride }, { ...passDeps, ...depsOverride });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.blockedReason).toBe(reason);
    });
  }

  it("customer messages never leak internal governance wording", () => {
    const forbidden = ["certificationonly", "phase c", "risk-007", "ecs", "credential reference", "promotion", "governance", "lifecycle"];
    for (const [inputOverride, depsOverride] of cases) {
      const r = evaluateOktaConnectGate({ ...passInput, ...inputOverride }, { ...passDeps, ...depsOverride });
      if (!r.ok) {
        const msg = r.customerMessage.toLowerCase();
        for (const f of forbidden) expect(msg.includes(f), `"${r.customerMessage}" leaked "${f}"`).toBe(false);
      }
    }
  });
});
