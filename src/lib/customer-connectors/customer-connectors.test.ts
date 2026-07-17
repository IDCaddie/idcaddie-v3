import { describe, it, expect, vi } from "vitest";

// P5E17 unit invariants (node env — no window). Covers: the SSRF-safe Okta org-host validator, the catalog's
// internal→customer mapping (nothing live, only Okta connectable, defense-in-depth against a genuinely-ready provider),
// and the demo store's server-side no-op safety (it must never touch anything when there is no browser).

import { validateOktaOrgHost, normalizeOrgInput } from "./okta-content";

describe("normalizeOrgInput (bare-label convenience — no new host shape accepted)", () => {
  it("appends .okta.com to a bare single label", () => {
    expect(normalizeOrgInput("acme")).toBe("acme.okta.com");
    expect(normalizeOrgInput("  ACME  ")).toBe("acme.okta.com");
    expect(normalizeOrgInput("my-company")).toBe("my-company.okta.com");
  });
  it("passes an already-qualified / https / punctuated value through unchanged (validator stays authoritative)", () => {
    expect(normalizeOrgInput("acme.okta.com")).toBe("acme.okta.com");
    expect(normalizeOrgInput("acme.oktapreview.com")).toBe("acme.oktapreview.com");
    expect(normalizeOrgInput("https://acme.okta.com")).toBe("https://acme.okta.com");
    expect(normalizeOrgInput("evil.com/path")).toBe("evil.com/path");
  });
  it("does NOT append in custom-domain (advanced) mode", () => {
    expect(normalizeOrgInput("acme", { customDomain: true })).toBe("acme");
  });
  it("never turns a bare label into a non-okta or unsafe host (still validates strictly)", () => {
    // a bare label always yields <label>.okta.com, which the strict validator accepts as an okta apex
    expect(validateOktaOrgHost(normalizeOrgInput("acme"))).toEqual({ ok: true, host: "acme.okta.com" });
    // anything with a dot passes through and is validated as-is (no silent widening)
    expect(validateOktaOrgHost(normalizeOrgInput("evil.com")).ok).toBe(false);
  });
});

describe("validateOktaOrgHost (SSRF-safe org address)", () => {
  const accept: [string, string][] = [
    ["acme.okta.com", "acme.okta.com"],
    ["ACME.okta.com", "acme.okta.com"],
    ["  acme.okta.com  ", "acme.okta.com"],
    ["acme.oktapreview.com", "acme.oktapreview.com"],
    ["acme.okta-emea.com", "acme.okta-emea.com"],
    ["https://acme.okta.com", "acme.okta.com"], // tolerated https prefix, stripped
  ];
  for (const [input, host] of accept) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      expect(validateOktaOrgHost(input)).toEqual({ ok: true, host });
    });
  }

  const reject: [string, string][] = [
    ["", "empty"],
    ["   ", "empty"],
    ["evil.com", "not_okta_domain"],
    ["acme.okta.com.evil.com", "not_okta_domain"],
    ["http://acme.okta.com", "has_scheme"],
    ["ftp://acme.okta.com", "has_scheme"],
    ["javascript:alert(1)", "has_scheme"],
    ["data:text/html,x", "has_scheme"],
    ["acme.okta.com/path", "has_path_or_query"],
    ["acme.okta.com?x=1", "has_path_or_query"],
    ["acme.okta.com#frag", "has_path_or_query"],
    ["acme okta.com", "has_path_or_query"],
    ["user@acme.okta.com", "has_credentials_or_port"],
    ["acme.okta.com:8080", "has_credentials_or_port"],
    ["localhost", "localhost_or_internal"],
    ["okta.internal", "localhost_or_internal"],
    ["okta.local", "localhost_or_internal"],
    ["127.0.0.1", "ip_literal"],
    ["10.0.0.1", "ip_literal"],
    ["192.168.1.1", "ip_literal"],
    ["[::1]", "ip_literal"],
    ["not-okta", "bad_shape"],
  ];
  for (const [input, reason] of reject) {
    it(`rejects ${JSON.stringify(input)} → ${reason}`, () => {
      const r = validateOktaOrgHost(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    });
  }

  it("never returns a host that isn't an okta apex", () => {
    for (const bad of ["evil.com", "acme.oktaX.com", "acme.notokta.com", "okta.com.evil.io"]) {
      const r = validateOktaOrgHost(bad);
      expect(r.ok).toBe(false);
    }
  });
});

describe("catalog internal→customer mapping", () => {
  it("maps the registry to safe cards: 12 providers, nothing live, only Okta connectable", async () => {
    vi.resetModules();
    vi.doMock("../server/connector-vault/provider-registry", () => ({
      getConnectorProvider: () => null,
      isConnectorProviderReady: () => false, // production truth today
    }));
    const { listCustomerConnectors, getCustomerConnector } = await import("./catalog");
    const all = listCustomerConnectors();

    expect(all.length).toBe(12);
    expect(all.some((c) => c.provider === "scim_fixture")).toBe(false); // internal fixture never surfaced
    // nothing is live this phase
    expect(all.every((c) => c.canSync === false)).toBe(true);
    expect(all.every((c) => c.canSchedule === false)).toBe(true);
    // ONLY Okta is preview-connectable
    expect(all.filter((c) => c.canConnect).map((c) => c.provider)).toEqual(["okta"]);
    // preview set vs coming-soon
    expect(getCustomerConnector("okta")?.availability).toBe("preview");
    expect(getCustomerConnector("microsoft_entra")?.availability).toBe("preview");
    expect(getCustomerConnector("salesforce")?.availability).toBe("coming_soon");
    expect(getCustomerConnector("nope")).toBeNull();
    vi.doUnmock("../server/connector-vault/provider-registry");
  });

  it("defense in depth: a provider that is genuinely registry-ready is NOT offered a preview connect", async () => {
    vi.resetModules();
    vi.doMock("../server/connector-vault/provider-registry", () => ({
      getConnectorProvider: () => null,
      isConnectorProviderReady: (p: string) => p === "okta", // pretend Okta went live
    }));
    const { getCustomerConnector } = await import("./catalog");
    expect(getCustomerConnector("okta")?.canConnect).toBe(false); // never surface a runnable provider as a "preview"
    vi.doUnmock("../server/connector-vault/provider-registry");
    vi.resetModules();
  });
});

describe("demo store is a browser-only no-op on the server", () => {
  it("reads null and writes nothing when there is no window", async () => {
    // node env: typeof window === "undefined"
    const store = await import("./demo-store");
    expect(store.getDemoConnection("okta")).toBeNull();
    expect(store.getDemoRaw()).toBe("");
    // these must not throw server-side
    expect(() => store.setDemoConnection("okta", { status: "connected_preview", orgHost: "acme.okta.com", connectedAt: "x" })).not.toThrow();
    expect(() => store.clearDemoConnection("okta")).not.toThrow();
    expect(store.getDemoConnection("okta")).toBeNull(); // still nothing persisted
  });
});
