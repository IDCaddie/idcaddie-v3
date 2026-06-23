import { describe, it, expect } from "vitest";
import {
  applyDeterministicResolution,
  revertCanonicalAppAssignment,
  repointAppAlias,
  type CanonicalGraphWriteStore,
} from "./resolver-write";
import { type StagedDiscoveryFactRow } from "./discovery-fact-read";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

// An in-memory canonical-graph store that faithfully models NATURAL-KEY upsert semantics (one tenant's
// RLS-scoped view). It tracks row counts so "run twice -> count unchanged" is a REAL property of the helper
// consistently upserting on natural keys — not the mock cheating. It also tracks "historical" users/contracts/
// invoices counts so unmerge can be proven NON-destructive.
function fixtureStore(seedInstances: { appId: string; aliasType: "instance_domain" | "external_instance_id"; aliasValue: string }[] = []) {
  const vendors = new Map<string, string>();        // normalized_name -> id
  const products = new Map<string, string>();        // vendorId|normalized_name -> id
  const aliases = new Map<string, string>();         // aliasType|aliasValue -> app_product_id
  const apps = new Map<string, { canonicalAppId: string | null }>();
  const appByInstance = new Map<string, string>();   // aliasType|aliasValue -> appId
  for (const s of seedInstances) {
    apps.set(s.appId, { canonicalAppId: null });
    appByInstance.set(`${s.aliasType}|${s.aliasValue.toLowerCase()}`, s.appId);
  }
  // immutable historical evidence the unmerge/repoint path must never delete
  const historical = { appUsers: 5, contracts: 3, invoices: 4 };
  let vid = 0, pid = 0;

  const store: CanonicalGraphWriteStore = {
    async upsertVendor({ normalizedName, displayName }) {
      void displayName;
      const ex = vendors.get(normalizedName);
      if (ex) return { id: ex };
      const id = `v-${++vid}`; vendors.set(normalizedName, id); return { id };
    },
    async upsertAppProduct({ vendorId, normalizedName, displayName }) {
      void displayName;
      const key = `${vendorId}|${normalizedName}`;
      const ex = products.get(key);
      if (ex) return { id: ex };
      const id = `p-${++pid}`; products.set(key, id); return { id };
    },
    async upsertAppAlias({ aliasType, aliasValue, appProductId }) {
      const key = `${aliasType}|${aliasValue}`;
      const ex = aliases.get(key);
      if (ex) return { created: false, resolvedAppProductId: ex }; // existing key wins (conflict detectable)
      aliases.set(key, appProductId); return { created: true, resolvedAppProductId: appProductId };
    },
    async findAppIdByInstanceKey({ aliasType, aliasValue }) {
      const appId = appByInstance.get(`${aliasType}|${aliasValue}`);
      if (!appId) return null;
      return { appId, canonicalAppId: apps.get(appId)!.canonicalAppId };
    },
    async setAppCanonicalAppId({ appId, appProductId }) {
      apps.set(appId, { canonicalAppId: appProductId });
    },
    async clearAppCanonicalAppId({ appId }) {
      const a = apps.get(appId); if (a) apps.set(appId, { canonicalAppId: null });
    },
    async repointAppAlias({ aliasType, aliasValue, newAppProductId }) {
      aliases.set(`${aliasType}|${aliasValue}`, newAppProductId);
    },
  };
  return {
    store,
    counts: () => ({ vendors: vendors.size, products: products.size, aliases: aliases.size }),
    canonicalOf: (appId: string) => apps.get(appId)?.canonicalAppId ?? null,
    aliasTarget: (aliasType: string, aliasValue: string) => aliases.get(`${aliasType}|${aliasValue}`) ?? null,
    historical,
  };
}

let seq = 0;
function fact(over: Record<string, unknown>): StagedDiscoveryFactRow {
  return { id: `df-${++seq}`, tenant_id: TENANT_A, fact_type: String(over.fact_type ?? "app_instance_identity"), fact_json: over };
}
const jiraFlywheel = () => fact({ fact_type: "app_instance_identity", discovered_vendor_name: "Atlassian", discovered_product_name: "Jira", instance_domain: "flywheel.atlassian.net" });
const jiraPerpetua = () => fact({ fact_type: "app_instance_identity", discovered_vendor_name: "Atlassian", discovered_product_name: "Jira", instance_domain: "perpetua.atlassian.net" });

describe("applyDeterministicResolution — deterministic-only writes, fail closed", () => {
  it("a deterministic instance fact writes an app_alias AND apps.canonical_app_id", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    const [r] = await applyDeterministicResolution(fx.store, TENANT_A, [jiraFlywheel()]);
    expect(r.outcome).toBe("wrote");
    expect(fx.counts().aliases).toBe(1);
    expect(fx.aliasTarget("instance_domain", "flywheel.atlassian.net")).not.toBeNull();
    expect(fx.canonicalOf("app-fly")).toBe(r.appProductId);
  });

  it("a probabilistic-only fact (vendor/product name, no instance key) does NOT write canonical_app_id or an alias", async () => {
    const fx = fixtureStore();
    const [r] = await applyDeterministicResolution(fx.store, TENANT_A, [
      fact({ fact_type: "app_discovery", discovered_vendor_name: "Atlassian", discovered_product_name: "Jira", discovered_app_name: "Jira" }),
    ]);
    expect(r.outcome).toBe("review");
    expect(fx.counts().aliases).toBe(0);
  });

  it("an ambiguous fact (name only) does NOT write app_aliases", async () => {
    const fx = fixtureStore();
    const [r] = await applyDeterministicResolution(fx.store, TENANT_A, [fact({ fact_type: "app_discovery", discovered_app_name: "Mystery" })]);
    expect(r.outcome).toBe("review");
    expect(fx.counts().aliases).toBe(0);
  });

  it("does NOT write when there is no authenticated tenant context", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    expect(await applyDeterministicResolution(fx.store, null, [jiraFlywheel()])).toEqual([]);
    expect(fx.counts().aliases).toBe(0);
    expect(fx.canonicalOf("app-fly")).toBeNull();
  });
});

describe("idempotency — natural-key upsert, persisted-state counts unchanged on re-run", () => {
  it("the same staged fact set run twice does NOT increase app_alias / product / vendor counts", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    const facts = [jiraFlywheel()];
    await applyDeterministicResolution(fx.store, TENANT_A, facts);
    const after1 = fx.counts();
    await applyDeterministicResolution(fx.store, TENANT_A, facts); // re-run identical set
    expect(fx.counts()).toEqual(after1); // vendors/products/aliases all unchanged
    expect(after1).toEqual({ vendors: 1, products: 1, aliases: 1 });
  });
});

describe("multi-instance — distinct instances never collapse", () => {
  it("Jira Flywheel and Jira Perpetua remain separate apps rows under one product, two aliases", async () => {
    const fx = fixtureStore([
      { appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" },
      { appId: "app-perp", aliasType: "instance_domain", aliasValue: "perpetua.atlassian.net" },
    ]);
    await applyDeterministicResolution(fx.store, TENANT_A, [jiraFlywheel(), jiraPerpetua()]);
    expect(fx.counts()).toEqual({ vendors: 1, products: 1, aliases: 2 }); // ONE product, TWO distinct aliases
    // the two distinct apps rows both group under the SAME canonical product, but stay separate apps rows
    expect(fx.canonicalOf("app-fly")).toBe(fx.canonicalOf("app-perp"));
    expect(fx.canonicalOf("app-fly")).not.toBeNull();
    // the two instance_domain aliases are distinct natural keys (not collapsed into one)
    expect(fx.aliasTarget("instance_domain", "flywheel.atlassian.net")).not.toBeNull();
    expect(fx.aliasTarget("instance_domain", "perpetua.atlassian.net")).not.toBeNull();
  });
});

describe("multi-source convergence — Slack from many sources, no duplicate aliases, order-independent", () => {
  const slackByDomain = () => fact({ fact_type: "app_instance_identity", discovered_vendor_name: "Slack", discovered_product_name: "Slack", instance_domain: "acme.slack.com" });
  const slackByExternalId = () => fact({ fact_type: "app_instance_identity", discovered_vendor_name: "Slack", discovered_product_name: "Slack", external_instance_id: "T0ACME" });

  it("multiple deterministic Slack sources converge to ONE product without duplicate aliases", async () => {
    const fx = fixtureStore();
    await applyDeterministicResolution(fx.store, TENANT_A, [slackByDomain(), slackByExternalId(), slackByDomain()]);
    // one vendor, one product; two distinct alias keys (domain + external id); the repeated domain is no dup
    expect(fx.counts()).toEqual({ vendors: 1, products: 1, aliases: 2 });
  });

  it("arrival order does not change the final persisted state", async () => {
    const a = fixtureStore(); await applyDeterministicResolution(a.store, TENANT_A, [slackByDomain(), slackByExternalId()]);
    const b = fixtureStore(); await applyDeterministicResolution(b.store, TENANT_A, [slackByExternalId(), slackByDomain()]);
    expect(a.counts()).toEqual(b.counts());
  });
});

describe("partial re-run — weak signal first stays reviewable, later deterministic reuses the path", () => {
  it("a weak signal then a deterministic signal for the same app does not create a parallel product", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    const weak = fact({ fact_type: "app_discovery", discovered_vendor_name: "Atlassian", discovered_product_name: "Jira", discovered_app_name: "Jira" });
    const [w] = await applyDeterministicResolution(fx.store, TENANT_A, [weak]);
    expect(w.outcome).toBe("review");
    expect(fx.counts().products).toBe(0); // weak signal wrote nothing
    const [d] = await applyDeterministicResolution(fx.store, TENANT_A, [jiraFlywheel()]);
    expect(d.outcome).toBe("wrote");
    expect(fx.counts().products).toBe(1); // ONE product — no parallel set
  });
});

describe("conflict — fail closed, never overwrite (false split safer than false merge)", () => {
  it("an instance already pointing at a DIFFERENT product is left in review, not re-merged", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    await fx.store.setAppCanonicalAppId({ appId: "app-fly", appProductId: "some-other-product" });
    const [r] = await applyDeterministicResolution(fx.store, TENANT_A, [jiraFlywheel()]);
    expect(r.outcome).toBe("review");
    expect(r.reason).toMatch(/conflict/i);
    expect(fx.canonicalOf("app-fly")).toBe("some-other-product"); // NOT overwritten
  });
});

describe("unmerge / repoint — non-destructive (never deletes users/contracts/invoices)", () => {
  it("revertCanonicalAppAssignment clears the canonical link without deleting historical rows", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    await applyDeterministicResolution(fx.store, TENANT_A, [jiraFlywheel()]);
    expect(fx.canonicalOf("app-fly")).not.toBeNull();
    const before = { ...fx.historical };
    expect((await revertCanonicalAppAssignment(fx.store, TENANT_A, { appId: "app-fly" })).ok).toBe(true);
    expect(fx.canonicalOf("app-fly")).toBeNull(); // un-linked...
    expect(fx.historical).toEqual(before); // ...but users/contracts/invoices untouched
  });

  it("repointAppAlias changes the alias target without deleting history", async () => {
    const fx = fixtureStore();
    await applyDeterministicResolution(fx.store, TENANT_A, [jiraFlywheel()]);
    const before = { ...fx.historical };
    expect((await repointAppAlias(fx.store, TENANT_A, { aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net", newAppProductId: "p-other" })).ok).toBe(true);
    expect(fx.aliasTarget("instance_domain", "flywheel.atlassian.net")).toBe("p-other");
    expect(fx.historical).toEqual(before);
  });

  it("unmerge/repoint do nothing without an authenticated tenant", async () => {
    const fx = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    expect((await revertCanonicalAppAssignment(fx.store, null, { appId: "app-fly" })).ok).toBe(false);
    expect((await repointAppAlias(fx.store, "", { aliasType: "instance_domain", aliasValue: "x", newAppProductId: "p" })).ok).toBe(false);
  });
});

describe("tenant isolation — a tenant's writes go only to its own RLS-scoped store", () => {
  it("tenant A's resolution does not touch tenant B's store (separate RLS-scoped stores)", async () => {
    const a = fixtureStore([{ appId: "app-fly", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    const b = fixtureStore([{ appId: "b-app", aliasType: "instance_domain", aliasValue: "flywheel.atlassian.net" }]);
    await applyDeterministicResolution(a.store, TENANT_A, [jiraFlywheel()]);
    // tenant B's store is untouched — its instance has no canonical link, no aliases
    expect(b.counts().aliases).toBe(0);
    expect(b.canonicalOf("b-app")).toBeNull();
  });
});

// Static guards: the write module imports ONLY sibling pure logic; no Supabase / db client, no createClient,
// no service-role, no fetch, no connector_secrets, no app_user_identity_matches, no HTTP route, no client import.
describe("resolver-write module is server-safe (no db client / fetch / service-role / matches / route)", () => {
  it("imports only sibling server-only modules and has no forbidden call/string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "resolver-write.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./discovery-fact-read", "./resolution"]);
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createClient\s*\(/);
    expect(code).not.toMatch(/createServiceClient/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toContain(["service", "role"].join("_"));
    expect(code).not.toContain(["connector", "secrets"].join("_"));
    // this PR NEVER writes the person/app_user match table, and exposes no HTTP route
    expect(code).not.toContain(["app", "user", "identity", "matches"].join("_"));
    for (const bad of ["export async function GET", "export async function POST", "NextRequest", "NextResponse"]) {
      expect(code).not.toContain(bad);
    }
  });
});
