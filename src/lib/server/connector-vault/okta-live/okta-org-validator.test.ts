import { describe, it, expect } from "vitest";
import { validateOktaOrganization } from "./okta-org-validator";
import { OKTA_APPROVED_SCOPES, OKTA_PROHIBITED_SCOPES, scopesExactlyApproved, OKTA_LIFECYCLE, oktaLifecyclePermitsPilotConnection, oktaLifecyclePermitsExecution } from "./okta-provider-contract";

// P5E18a Phase 3/19 — table-driven proof of the SSRF-safe Okta org/issuer validator + the provider-contract scope/lifecycle gates.

describe("validateOktaOrganization — accepts standard + allowlisted custom domains", () => {
  const accept: [string, string, string][] = [
    // input, expected hostname, expected issuer
    ["acme.okta.com", "acme.okta.com", "https://acme.okta.com"],
    ["ACME.Okta.Com", "acme.okta.com", "https://acme.okta.com"],
    ["  acme.okta.com  ", "acme.okta.com", "https://acme.okta.com"],
    ["acme.oktapreview.com", "acme.oktapreview.com", "https://acme.oktapreview.com"],
    ["acme.okta-emea.com", "acme.okta-emea.com", "https://acme.okta-emea.com"],
    ["https://acme.okta.com", "acme.okta.com", "https://acme.okta.com"],
    ["acme", "acme.okta.com", "https://acme.okta.com"], // bare label → standard domain
    ["my-company", "my-company.okta.com", "https://my-company.okta.com"],
  ];
  for (const [input, host, issuer] of accept) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      const r = validateOktaOrganization(input);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.hostname).toBe(host);
        expect(r.issuerUrl).toBe(issuer);
        expect(r.orgLabel).toBe(input.trim()); // label preserved (trimmed) — display only
      }
    });
  }

  it("accepts an explicitly allowlisted custom Okta domain (exact match only)", () => {
    const r = validateOktaOrganization("id.customer.com", { allowedCustomDomains: ["id.customer.com"] });
    expect(r).toEqual({ ok: true, orgLabel: "id.customer.com", hostname: "id.customer.com", issuerUrl: "https://id.customer.com" });
  });
  it("rejects a custom domain not on the allowlist", () => {
    const r = validateOktaOrganization("id.customer.com", { allowedCustomDomains: ["other.customer.com"] });
    expect(r).toEqual({ ok: false, reason: "not_allowed_custom_domain" });
  });
});

describe("validateOktaOrganization — SSRF + malformed rejection", () => {
  const reject: [unknown, string][] = [
    ["", "empty"],
    ["   ", "empty"],
    [123, "not_string"],
    [null, "not_string"],
    ["acme okta.com", "has_whitespace"],
    ["http://acme.okta.com", "non_https_scheme"],
    ["ftp://acme.okta.com", "non_https_scheme"],
    ["ws://acme.okta.com", "non_https_scheme"],
    ["javascript:alert(1)", "non_https_scheme"],
    ["data:text/html,x", "non_https_scheme"],
    ["user:pass@acme.okta.com", "has_credentials"],
    ["user@acme.okta.com", "has_credentials"],
    ["acme.okta.com/redirect?to=evil", "has_path_or_query_or_fragment"],
    ["acme.okta.com?x=1", "has_path_or_query_or_fragment"],
    ["acme.okta.com#frag", "has_path_or_query_or_fragment"],
    ["acme.okta.com:8080", "has_port"],
    ["localhost", "loopback"],
    ["app.localhost", "loopback"],
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["10.0.0.1", "private_or_link_local"],
    ["192.168.1.1", "private_or_link_local"],
    ["172.16.0.1", "private_or_link_local"],
    ["169.254.169.254", "private_or_link_local"], // cloud metadata SSRF target
    ["100.100.100.100", "private_or_link_local"], // CGNAT
    ["fe80::1", "private_or_link_local"],
    ["8.8.8.8", "ip_literal"],
    ["okta.internal", "localhost_or_internal"],
    ["okta.local", "localhost_or_internal"],
    ["evil.com", "not_okta_domain"],
    ["acme.okta.com.evil.com", "not_okta_domain"],
    ["xn--acme.okta.com", "bad_punycode"],
    ["café.okta.com", "invalid_hostname"], // non-ASCII
    ["-acme.okta.com", "invalid_hostname"],
    ["acme.okta.com.", "invalid_hostname"], // trailing dot
  ];
  for (const [input, reason] of reject) {
    it(`rejects ${JSON.stringify(input)} → ${reason}`, () => {
      const r = validateOktaOrganization(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    });
  }

  it("never accepts a non-Okta host and never returns a non-https issuer", () => {
    for (const bad of ["evil.com", "attacker-okta.com", "okta.com.evil.io", "http://acme.okta.com", "169.254.169.254"]) {
      const r = validateOktaOrganization(bad);
      expect(r.ok).toBe(false);
    }
  });
});

describe("okta provider contract — scopes + lifecycle", () => {
  it("approves exactly okta.users.read; rejects empty/extra/prohibited/duplicate", () => {
    expect(scopesExactlyApproved(["okta.users.read"])).toEqual({ ok: true });
    expect(scopesExactlyApproved([])).toEqual({ ok: false, reason: "empty" });
    expect(scopesExactlyApproved(["okta.users.read", "okta.groups.read"])).toEqual({ ok: false, reason: "prohibited" });
    expect(scopesExactlyApproved(["okta.users.read", "openid"])).toEqual({ ok: false, reason: "not_exact_approved_set" });
    expect(scopesExactlyApproved(["okta.users.read", "okta.users.read"])).toEqual({ ok: false, reason: "duplicate" });
    expect(scopesExactlyApproved(["okta.apps.read"])).toEqual({ ok: false, reason: "prohibited" });
  });
  it("approved set is exactly the least-privilege read scope; no write/admin scope is approved", () => {
    expect(OKTA_APPROVED_SCOPES).toEqual(["okta.users.read"]);
    for (const s of OKTA_APPROVED_SCOPES) expect((OKTA_PROHIBITED_SCOPES as readonly string[]).includes(s)).toBe(false);
    expect(OKTA_PROHIBITED_SCOPES.some((s) => s.includes(".manage") || s.includes(".write"))).toBe(true);
  });
  it("lifecycle is certificationOnly and permits neither pilot connection nor execution", () => {
    expect(OKTA_LIFECYCLE).toBe("certificationOnly");
    expect(oktaLifecyclePermitsPilotConnection(OKTA_LIFECYCLE)).toBe(false);
    expect(oktaLifecyclePermitsExecution(OKTA_LIFECYCLE)).toBe(false);
    // even a future pilotReady still cannot EXECUTE (only enabled can)
    expect(oktaLifecyclePermitsPilotConnection("pilotReady")).toBe(true);
    expect(oktaLifecyclePermitsExecution("pilotReady")).toBe(false);
    expect(oktaLifecyclePermitsExecution("enabled")).toBe(true);
  });
});
