import { describe, it, expect } from "vitest";
import {
  oktaApplicationToFacts,
  oktaUserToFacts,
  oktaAssignmentToFacts,
  emitOktaDiscoveryFacts,
  type OktaDiscoverySource,
  type OktaEmitContext,
} from "./okta-discovery-emitter";
import { hasForbiddenFactKey, type DiscoveryFact } from "./discovery-facts";
import { type DiscoveryFactStagingRow, type DiscoveryFactStagingStore } from "./discovery-fact-staging";

const TENANT = "11111111-1111-1111-1111-111111111111";
const CTX: OktaEmitContext = { observedAt: "2026-06-23T00:00:00.000Z", sourceRunId: "run-1" };

// A capturing staging store — records the exact staged rows (so we can assert natural_key, tenant_id, and that
// no forbidden material reaches the row). It models the real RLS-backed store's success path.
function capturingStore() {
  const rows: DiscoveryFactStagingRow[] = [];
  const store: DiscoveryFactStagingStore = {
    async stage(row) { rows.push(row); return { ok: true, id: `id-${rows.length}` }; },
  };
  return { store, rows };
}

// Search a value tree for a key (used to prove an unexpected/secret field never reaches the emitted fact).
function deepHasKey(value: unknown, key: string): boolean {
  if (value == null || typeof value !== "object") return false;
  for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
    if (k === key) return true;
    if (deepHasKey(child, key)) return true;
  }
  return false;
}
function deepHasValue(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (value == null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((c) => deepHasValue(c, needle));
}

describe("Okta application → discovery facts", () => {
  it("emits a valid app_discovery fact (name + deterministic Okta app id)", () => {
    const facts = oktaApplicationToFacts({ id: "0oa1", label: "Atlassian Jira", status: "ACTIVE", signOnMode: "SAML_2_0" }, TENANT, CTX);
    const disc = facts.find((f) => f.fact_type === "app_discovery") as Extract<DiscoveryFact, { fact_type: "app_discovery" }>;
    expect(disc).toBeTruthy();
    expect(disc.discovered_app_name).toBe("Atlassian Jira");
    expect(disc.source_app_id).toBe("0oa1");
    expect(disc.source_provider).toBe("okta");
    expect(disc.source_type).toBe("identity_provider_discovery");
    expect(disc.tenant_id).toBe(TENANT);
    expect(disc.confidence).toBe(0.9);
  });

  it("emits a deterministic app_instance_identity fact carrying provider_app_id as external_instance_id", () => {
    const facts = oktaApplicationToFacts({ id: "0oa1", label: "Jira" }, TENANT, CTX);
    const inst = facts.find((f) => f.fact_type === "app_instance_identity") as Extract<DiscoveryFact, { fact_type: "app_instance_identity" }>;
    expect(inst).toBeTruthy();
    expect(inst.external_instance_id).toBe("0oa1"); // the Okta app id == provider_app_id
  });

  it("emits instance_domain ONLY from an explicit structured settings.app.domain field", () => {
    const facts = oktaApplicationToFacts(
      { id: "0oa1", label: "Jira", settings: { app: { domain: "flywheel.atlassian.net", url: "https://flywheel.atlassian.net" } } },
      TENANT, CTX,
    );
    const inst = facts.find((f) => f.fact_type === "app_instance_identity") as Extract<DiscoveryFact, { fact_type: "app_instance_identity" }>;
    expect(inst.instance_domain).toBe("flywheel.atlassian.net");
    expect(inst.instance_url).toBe("https://flywheel.atlassian.net");
  });

  // ── point 3: domain must be EXPLICIT, never inferred ──
  it("an app with only label/name/signOnMode/status (no explicit domain/URL) emits NO domain/instance_domain", () => {
    const facts = oktaApplicationToFacts({ id: "0oa1", label: "Some App", name: "someapp", signOnMode: "SAML_2_0", status: "ACTIVE" }, TENANT, CTX);
    for (const f of facts) {
      expect(deepHasKey(f, "instance_domain")).toBe(false);
      expect(deepHasKey(f, "discovered_domain")).toBe(false);
      expect(deepHasKey(f, "instance_url")).toBe(false);
    }
    // the app_instance_identity (external_instance_id only) is still emitted — that is NOT a domain alias
    expect(facts.some((f) => f.fact_type === "app_instance_identity")).toBe(true);
  });

  it("a domain is NEVER inferred from label/name/signOnMode (those are not domains)", () => {
    const facts = oktaApplicationToFacts({ id: "0oa1", label: "acme.com", name: "acme.com", signOnMode: "acme.com" }, TENANT, CTX);
    for (const f of facts) expect(deepHasKey(f, "instance_domain")).toBe(false);
  });

  // ── point 1 + 2: allowlist construction; unexpected/secret fields never leak ──
  it("an unexpected extra field on the Okta app does NOT appear in fact_json or provenance", () => {
    const facts = oktaApplicationToFacts(
      { id: "0oa1", label: "Jira", weird_unexpected_field: "should-not-leak", _links: { x: "y" } },
      TENANT, CTX,
    );
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(deepHasKey(f, "weird_unexpected_field")).toBe(false);
      expect(deepHasValue(f, "should-not-leak")).toBe(false);
      expect(deepHasKey(f, "_links")).toBe(false);
    }
  });

  it("app secret/config landmines (settings.signOn, credentials, client_secret, tokens, cookies) never leak", () => {
    const facts = oktaApplicationToFacts(
      {
        id: "0oa1", label: "Jira",
        settings: { app: { domain: "flywheel.atlassian.net" }, signOn: { ssoAcsUrl: "x", signingKey: "PRIVATE-KEY" } },
        credentials: { client_secret: "shh", signing: { kid: "k1", key: "PRIVATE" } },
        _links: { logo: [{ href: "https://x" }] },
        access_token: "tok", authorization: "Bearer xyz", cookies: "session=abc",
      },
      TENANT, CTX,
    );
    for (const f of facts) {
      expect(hasForbiddenFactKey(f)).toBe(false);
      for (const bad of ["signOn", "signingKey", "credentials", "client_secret", "_links", "access_token", "authorization", "cookies"]) {
        expect(deepHasKey(f, bad)).toBe(false);
      }
      for (const v of ["PRIVATE-KEY", "PRIVATE", "shh", "tok", "Bearer xyz", "session=abc"]) {
        expect(deepHasValue(f, v)).toBe(false);
      }
    }
    // the explicit safe domain still came through
    expect(facts.some((f) => f.fact_type === "app_instance_identity" && (f as { instance_domain?: string }).instance_domain === "flywheel.atlassian.net")).toBe(true);
  });

  it("a malformed Okta app (no id) is skipped safely", () => {
    expect(oktaApplicationToFacts({ label: "No Id" }, TENANT, CTX)).toEqual([]);
    expect(oktaApplicationToFacts(null, TENANT, CTX)).toEqual([]);
    expect(oktaApplicationToFacts("nope", TENANT, CTX)).toEqual([]);
  });
});

describe("Okta user → discovery facts (email/login normalization is trim + lowercase only)", () => {
  it("emits app_user_account + person_identity_candidate with a normalized email", () => {
    const facts = oktaUserToFacts({ id: "00u1", status: "ACTIVE", profile: { email: "  Jane.Doe@Acme.com ", firstName: "Jane", lastName: "Doe" } }, TENANT, CTX);
    const account = facts.find((f) => f.fact_type === "app_user_account") as Extract<DiscoveryFact, { fact_type: "app_user_account" }>;
    const person = facts.find((f) => f.fact_type === "person_identity_candidate") as Extract<DiscoveryFact, { fact_type: "person_identity_candidate" }>;
    expect(account.email).toBe("jane.doe@acme.com");
    expect(account.source_user_id).toBe("00u1");
    expect(person.primary_email).toBe("jane.doe@acme.com");
  });

  it("Jane.Doe@Acme.com matches jane.doe@acme.com (case/space only)", () => {
    const a = oktaUserToFacts({ id: "00u1", profile: { email: "Jane.Doe@Acme.com" } }, TENANT, CTX);
    const b = oktaUserToFacts({ id: "00u2", profile: { email: "jane.doe@acme.com" } }, TENANT, CTX);
    const ea = (a.find((f) => f.fact_type === "person_identity_candidate") as { primary_email: string }).primary_email;
    const eb = (b.find((f) => f.fact_type === "person_identity_candidate") as { primary_email: string }).primary_email;
    expect(ea).toBe(eb);
  });

  it("jane.doe@acme.com does NOT match janedoe@acme.com (dots significant)", () => {
    const a = (oktaUserToFacts({ id: "00u1", profile: { email: "jane.doe@acme.com" } }, TENANT, CTX).find((f) => f.fact_type === "person_identity_candidate") as { primary_email: string }).primary_email;
    const b = (oktaUserToFacts({ id: "00u2", profile: { email: "janedoe@acme.com" } }, TENANT, CTX).find((f) => f.fact_type === "person_identity_candidate") as { primary_email: string }).primary_email;
    expect(a).not.toBe(b);
  });

  it("jane+test@acme.com does NOT match jane@acme.com (plus tags significant)", () => {
    const a = (oktaUserToFacts({ id: "00u1", profile: { email: "jane+test@acme.com" } }, TENANT, CTX).find((f) => f.fact_type === "person_identity_candidate") as { primary_email: string }).primary_email;
    const b = (oktaUserToFacts({ id: "00u2", profile: { email: "jane@acme.com" } }, TENANT, CTX).find((f) => f.fact_type === "person_identity_candidate") as { primary_email: string }).primary_email;
    expect(a).not.toBe(b);
  });

  it("falls back to profile.login (normalized) when email is absent", () => {
    const facts = oktaUserToFacts({ id: "00u1", profile: { login: "USER@Acme.com" } }, TENANT, CTX);
    expect((facts.find((f) => f.fact_type === "app_user_account") as { email?: string }).email).toBe("user@acme.com");
  });

  it("a malformed Okta user (no id) is skipped safely", () => {
    expect(oktaUserToFacts({ profile: { email: "x@y.com" } }, TENANT, CTX)).toEqual([]);
    expect(oktaUserToFacts(undefined, TENANT, CTX)).toEqual([]);
  });

  it("an unexpected/secret field on the Okta user never leaks", () => {
    const facts = oktaUserToFacts({ id: "00u1", profile: { email: "a@b.com", ssn: "123-45-6789" }, refresh_token: "rt", weird: "leak-me" }, TENANT, CTX);
    for (const f of facts) {
      expect(hasForbiddenFactKey(f)).toBe(false);
      expect(deepHasKey(f, "ssn")).toBe(false);
      expect(deepHasKey(f, "weird")).toBe(false);
      expect(deepHasValue(f, "leak-me")).toBe(false);
      expect(deepHasValue(f, "123-45-6789")).toBe(false);
    }
  });
});

describe("Okta assignment → app-user/app relationship fact", () => {
  it("emits an app_user_account carrying the user↔app relationship (app_id_hint)", () => {
    const facts = oktaAssignmentToFacts({ id: "00u1", status: "ACTIVE", scope: "USER", profile: { email: "a@b.com" } }, "0oa1", TENANT, CTX);
    const f = facts[0] as Extract<DiscoveryFact, { fact_type: "app_user_account" }>;
    expect(f.fact_type).toBe("app_user_account");
    expect(f.app_id_hint).toBe("0oa1");
    expect(f.app_user_external_id).toBe("00u1");
    expect(f.email).toBe("a@b.com");
  });

  it("a malformed assignment (no user id or no app id) is skipped safely", () => {
    expect(oktaAssignmentToFacts({ status: "ACTIVE" }, "0oa1", TENANT, CTX)).toEqual([]);
    expect(oktaAssignmentToFacts({ id: "00u1" }, "", TENANT, CTX)).toEqual([]);
  });

  it("an unexpected/secret field on the assignment never leaks (allowlist holds on the assignment path too)", () => {
    const facts = oktaAssignmentToFacts(
      { id: "00u1", status: "ACTIVE", profile: { email: "a@b.com" }, access_token: "tok", _links: { x: "y" }, weird: "leak-me" },
      "0oa1", TENANT, CTX,
    );
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(hasForbiddenFactKey(f)).toBe(false);
      expect(deepHasKey(f, "weird")).toBe(false);
      expect(deepHasKey(f, "_links")).toBe(false);
      expect(deepHasValue(f, "leak-me")).toBe(false);
      expect(deepHasValue(f, "tok")).toBe(false);
    }
  });
});

describe("tenant safety", () => {
  it("a provider payload tenant_id is IGNORED — the fact uses the authenticated tenant", () => {
    const facts = oktaApplicationToFacts({ id: "0oa1", label: "Jira", tenant_id: "evil-tenant" }, TENANT, CTX);
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) expect(f.tenant_id).toBe(TENANT);
  });

  it("emitOktaDiscoveryFacts writes NOTHING without an authenticated tenant", async () => {
    const { store, rows } = capturingStore();
    const source: OktaDiscoverySource = {
      listApplications: async () => [{ id: "0oa1", label: "Jira" }],
      listUsers: async () => [{ id: "00u1", profile: { email: "a@b.com" } }],
      listAppUsers: async () => [],
    };
    const summary = await emitOktaDiscoveryFacts(source, store, "", CTX);
    expect(summary.staged).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe("natural_key stability (derives from immutable Okta ids, not label/status)", () => {
  const appSource = (app: Record<string, unknown>): OktaDiscoverySource => ({
    listApplications: async () => [app],
    listUsers: async () => [],
    listAppUsers: async () => [],
  });
  async function natKeys(app: Record<string, unknown>) {
    const { store, rows } = capturingStore();
    await emitOktaDiscoveryFacts(appSource(app), store, TENANT, CTX);
    return rows.map((r) => r.natural_key);
  }

  it("transforming the same Okta app twice produces identical natural_key values", async () => {
    const app = { id: "0oa1", label: "Jira", status: "ACTIVE" };
    expect(await natKeys(app)).toEqual(await natKeys(app));
  });

  it("two different Okta apps produce different natural_key values", async () => {
    const a = await natKeys({ id: "0oaAAA", label: "Jira" });
    const b = await natKeys({ id: "0oaBBB", label: "Jira" });
    expect(a).not.toEqual(b);
    expect(a.some((k) => b.includes(k!))).toBe(false);
  });

  it("changing label/status does NOT change natural_key when the Okta app id is the same", async () => {
    const before = await natKeys({ id: "0oa1", label: "Old Name", status: "ACTIVE" });
    const after = await natKeys({ id: "0oa1", label: "Brand New Name", status: "INACTIVE" });
    expect(after).toEqual(before);
  });

  it("the domain-keyed app_instance_identity natural_key is also stable across label/status changes", async () => {
    const settings = { app: { domain: "flywheel.atlassian.net" } };
    const before = await natKeys({ id: "0oa1", label: "Old", status: "ACTIVE", settings });
    const after = await natKeys({ id: "0oa1", label: "New", status: "INACTIVE", settings });
    expect(after).toEqual(before); // exercises the instance_domain-derived branch of computeNaturalKey
  });
});

describe("emitOktaDiscoveryFacts (integration through the safe staging path)", () => {
  it("stages app + assignment + user facts and binds every row to the authenticated tenant", async () => {
    const { store, rows } = capturingStore();
    const source: OktaDiscoverySource = {
      listApplications: async () => [{ id: "0oa1", label: "Jira", settings: { app: { domain: "flywheel.atlassian.net" } } }],
      listUsers: async () => [{ id: "00u1", profile: { email: "jane@acme.com" } }],
      listAppUsers: async (appId) => (appId === "0oa1" ? [{ id: "00u1", scope: "USER", profile: { email: "jane@acme.com" } }] : []),
    };
    const summary = await emitOktaDiscoveryFacts(source, store, TENANT, CTX);
    expect(summary.staged).toBe(summary.built);
    expect(summary.built).toBeGreaterThanOrEqual(4); // app_discovery + app_instance + assignment + (user account + person)
    expect(rows.every((r) => r.tenant_id === TENANT)).toBe(true);
    expect(rows.every((r) => r.source_provider === "okta")).toBe(true);
    expect(rows.every((r) => r.source_type === "identity_provider_discovery")).toBe(true);
    // no staged row carries forbidden material
    expect(rows.every((r) => !hasForbiddenFactKey(r.fact_json) && !hasForbiddenFactKey(r.provenance_json ?? {}))).toBe(true);
  });
});

// Static guard: server-only — imports ONLY the three sibling modules; no db client / fetch / service-role / route.
describe("okta-discovery-emitter is server-safe (no db client / fetch / service-role / canonical write / route)", () => {
  it("imports only sibling fact modules and contains no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "okta-discovery-emitter.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./discovery-fact-staging", "./discovery-facts", "./resolution"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/); // no live provider call in this module
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role"].join("_"));
    expect(code).not.toContain(["connector", "secrets"].join("_"));
    // no canonical-graph / identity-match / route surface
    for (const bad of ["canonical_app_id", "app_aliases", "upsertVendor", "app_products", "app_user_identity_matches", "NextRequest", "NextResponse", "export async function GET", "export async function POST"]) {
      expect(code).not.toContain(bad);
    }
  });
});
