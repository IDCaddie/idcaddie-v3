import { describe, it, expect } from "vitest";
import { evaluateOktaConfigGate, oktaConfigGatePermitsExecution, type OktaConfigGateInput, type OktaConfigGateDeps } from "./okta-config-gate";

const APPROVED_ORG = "org-a1-approved";
const OTHER_ORG = "org-b1-approved";
const DEPS: OktaConfigGateDeps = {
  approvedIssuerByOrganizationId: {
    [APPROVED_ORG]: "https://trial-5294016.okta.com",
    [OTHER_ORG]: "https://someone-else.okta.com", // a second approved org, bound to a DIFFERENT issuer
  },
};
const OK_INPUT: OktaConfigGateInput = {
  authenticated: true,
  role: "admin",
  provider: "okta",
  organizationId: APPROVED_ORG,
  rawOrganization: "trial-5294016.okta.com",
  requestedScopes: ["okta.users.read"],
  environment: "staging",
};

describe("okta-config-gate", () => {
  it("permits config persistence for the approved org + issuer + exact scope + admin", () => {
    const r = evaluateOktaConfigGate(OK_INPUT, DEPS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.organizationId).toBe(APPROVED_ORG);
      expect(r.issuerUrl).toBe("https://trial-5294016.okta.com");
      expect(r.hostname).toBe("trial-5294016.okta.com");
      expect(r.scopes).toEqual(["okta.users.read"]);
    }
  });

  it("NEVER authorizes execution", () => {
    expect(oktaConfigGatePermitsExecution()).toBe(false);
  });

  const cases: Array<[string, Partial<OktaConfigGateInput>, string]> = [
    ["unauthenticated", { authenticated: false }, "not_authenticated"],
    ["non-admin", { role: "viewer" }, "not_admin"],
    ["null role", { role: null }, "not_admin"],
    ["wrong provider", { provider: "slack" }, "provider_not_okta"],
    ["non-staging", { environment: "production" }, "environment_not_staging"],
    ["unapproved org", { organizationId: "some-other-org" }, "organization_not_approved"],
    ["empty org", { organizationId: "" }, "organization_not_approved"],
    ["invalid org host", { rawOrganization: "not-an-okta-host.example.com" }, "organization_invalid"],
    ["ssrf org host", { rawOrganization: "169.254.169.254" }, "organization_invalid"],
    ["unapproved issuer", { rawOrganization: "not-approved-at-all.okta.com" }, "issuer_not_approved"],
    // A1 is approved, and someone-else.okta.com is an approved issuer — but NOT for A1 (it's B1's). Must fail closed.
    ["approved issuer but wrong org pairing", { rawOrganization: "someone-else.okta.com" }, "issuer_not_approved"],
    ["scope escalation", { requestedScopes: ["okta.users.read", "okta.groups.read"] }, "scope_not_exact"],
    ["empty scope", { requestedScopes: [] }, "scope_not_exact"],
    ["wrong scope", { requestedScopes: ["okta.groups.read"] }, "scope_not_exact"],
  ];
  for (const [name, patch, reason] of cases) {
    it(`blocks: ${name} -> ${reason}`, () => {
      const r = evaluateOktaConfigGate({ ...OK_INPUT, ...patch }, DEPS);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.blockedReason).toBe(reason);
        // customer-safe message never leaks internal governance wording
        expect(/certificationOnly|Phase C|RISK-007|ARN|credential|client_secret|token/i.test(r.customerMessage)).toBe(false);
      }
    });
  }
});
