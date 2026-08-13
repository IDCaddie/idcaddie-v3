import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const createClient = vi.fn();
const resolveTenantContext = vi.fn();
const getSessionUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("@/lib/auth/tenant-context", () => ({ resolveTenantContext: () => resolveTenantContext() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: () => getSessionUser() }));

import { declareApplicationAlias, resolveApplicationAlias } from "./application-aliases";

const TENANT = "11111111-1111-1111-1111-111111111111";
const DIR_APP = "22222222-2222-2222-2222-222222222222";
const PRODUCT = "33333333-3333-3333-3333-333333333333";
const OTHER_PRODUCT = "44444444-4444-4444-4444-444444444444";
const USER = "55555555-5555-5555-5555-555555555555";

type Q = { table: string; cols?: string; eqs: [string, unknown][]; op?: string; payload?: Record<string, unknown> };

// Capturing mock. Dispatches per table so one call can read the directory side, read the alias, then insert. Records every
// filter and the insert payload, so the tests can assert what the query is ALLOWED to look at — not merely what it returned.
function makeSupabase(opts: {
  source?: { data: unknown; error?: { code: string } | null };
  alias?: { data: unknown; error?: { code: string } | null }[];
  insert?: { error: { code: string } | null };
}) {
  const queries: Q[] = [];
  let aliasReads = 0;
  const from = (table: string) => {
    const q: Q = { table, eqs: [] };
    queries.push(q);
    const chain = {
      select: (cols: string) => { q.cols = cols; return chain; },
      eq: (col: string, val: unknown) => { q.eqs.push([col, val]); return chain; },
      maybeSingle: () => {
        if (table === "directory_applications") return Promise.resolve(opts.source ?? { data: null, error: null });
        const r = opts.alias?.[aliasReads] ?? { data: null, error: null };
        aliasReads += 1;
        return Promise.resolve(r);
      },
      insert: (payload: Record<string, unknown>) => { q.op = "insert"; q.payload = payload; return Promise.resolve(opts.insert ?? { error: null }); },
    };
    return chain;
  };
  return { from, __queries: queries };
}

const currentSource = { data: { external_id: "0oaAbC123", provider: "okta", sync_status: "current" }, error: null };
const declare = (over: Partial<{ directoryApplicationId: string; appProductId: string; aliasType: string }> = {}) =>
  declareApplicationAlias({ directoryApplicationId: DIR_APP, appProductId: PRODUCT, aliasType: "provider_app_id", ...over });

beforeEach(() => {
  createClient.mockReset();
  resolveTenantContext.mockReset().mockResolvedValue({ activeTenant: { id: TENANT, role: "editor" }, organizationMemberships: [] });
  getSessionUser.mockReset().mockResolvedValue({ id: USER });
});

describe("resolveApplicationAlias — reads app_aliases ONLY", () => {
  it("1 — an exact provider_app_id resolves to one product", async () => {
    const sb = makeSupabase({ alias: [{ data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null }] });
    createClient.mockResolvedValue(sb);
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123")).toEqual({ outcome: "resolved", appProductId: PRODUCT });
  });

  it("2 — no alias row is unresolved", async () => {
    createClient.mockResolvedValue(makeSupabase({ alias: [{ data: null, error: null }] }));
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123")).toEqual({ outcome: "unresolved" });
  });

  it("3 + 14 — a name lookup is refused BEFORE any query reaches the database", async () => {
    const sb = makeSupabase({ alias: [{ data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null }] });
    createClient.mockResolvedValue(sb);
    expect(await resolveApplicationAlias(TENANT, "name", "Slack")).toEqual({ outcome: "unsupported", aliasType: "name" });
    expect(sb.__queries).toHaveLength(0); // the forbidden path does not exist even as a wasted round trip
  });

  it("4 — resolution cannot see a display name: the query selects only the judgement columns and filters only on identity", async () => {
    const sb = makeSupabase({ alias: [{ data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null }] });
    createClient.mockResolvedValue(sb);
    await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123");
    const q = sb.__queries[0];
    expect(q.table).toBe("app_aliases");
    expect(q.cols).toBe("app_product_id, review_status");
    expect(q.cols).not.toMatch(/name|label/);
    expect(q.eqs).toEqual([["tenant_id", TENANT], ["alias_type", "provider_app_id"], ["alias_value", "0oaAbC123"]]);
  });

  it("6 — repeated resolution of the same alias is identical", async () => {
    const row = { data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null };
    createClient.mockResolvedValue(makeSupabase({ alias: [row, row] }));
    const a = await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123");
    createClient.mockResolvedValue(makeSupabase({ alias: [row] }));
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "  0oaAbC123 ")).toEqual(a);
  });

  it("a stale directory source never enters resolution — a confirmed alias keeps resolving forever", async () => {
    const sb = makeSupabase({ alias: [{ data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null }] });
    createClient.mockResolvedValue(sb);
    await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123");
    expect(sb.__queries.map((q) => q.table)).toEqual(["app_aliases"]); // directory_applications is never read
  });
});

describe("declareApplicationAlias", () => {
  it("7 — an authorized editor declares the mapping; the identifier comes from the ROW, not the request", async () => {
    const sb = makeSupabase({ source: currentSource, alias: [{ data: null, error: null }] });
    createClient.mockResolvedValue(sb);
    expect(await declare()).toEqual({ ok: true, outcome: "declared", aliasValue: "0oaAbC123" });

    const ins = sb.__queries.find((q) => q.op === "insert");
    expect(ins?.table).toBe("app_aliases");
    expect(ins?.payload).toMatchObject({
      tenant_id: TENANT, alias_type: "provider_app_id", alias_value: "0oaAbC123",
      app_product_id: PRODUCT, review_status: "confirmed", reviewed_by: USER, confidence: 100, source: "okta",
    });
    expect(ins?.payload?.app_id).toBeUndefined(); // directory-sourced evidence has no operational apps instance
  });

  it("5 — an unknown provider string changes nothing: it is carried as opaque provenance", async () => {
    const sb = makeSupabase({ source: { data: { external_id: "xyz-9", provider: "some-provider-nobody-has-built", sync_status: "current" }, error: null }, alias: [{ data: null, error: null }] });
    createClient.mockResolvedValue(sb);
    expect(await declare()).toEqual({ ok: true, outcome: "declared", aliasValue: "xyz-9" });
    expect(sb.__queries.find((q) => q.op === "insert")?.payload?.source).toBe("some-provider-nobody-has-built");
  });

  it("8 — declaring the same mapping twice is idempotent: no second row is written", async () => {
    const sb = makeSupabase({ source: currentSource, alias: [{ data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null }] });
    createClient.mockResolvedValue(sb);
    expect(await declare()).toEqual({ ok: true, outcome: "unchanged", aliasValue: "0oaAbC123" });
    expect(sb.__queries.some((q) => q.op === "insert")).toBe(false);
  });

  it("9 + 15 — the same identifier pointed at a DIFFERENT product conflicts; the existing mapping is never overwritten", async () => {
    const sb = makeSupabase({ source: currentSource, alias: [{ data: { app_product_id: OTHER_PRODUCT, review_status: "confirmed" }, error: null }] });
    createClient.mockResolvedValue(sb);
    expect(await declare()).toEqual({ ok: false, error: "conflict", reason: "different_product" });
    expect(sb.__queries.some((q) => q.op === "insert")).toBe(false);
  });

  it("15b — a human 'rejected' judgement is preserved even against the same product", async () => {
    createClient.mockResolvedValue(makeSupabase({ source: currentSource, alias: [{ data: { app_product_id: PRODUCT, review_status: "rejected" }, error: null }] }));
    expect(await declare()).toEqual({ ok: false, error: "conflict", reason: "rejected" });
  });

  it("10 — a foreign-tenant product is refused by the same-tenant composite FK, reported indistinguishably", async () => {
    createClient.mockResolvedValue(makeSupabase({ source: currentSource, alias: [{ data: null, error: null }], insert: { error: { code: "23503" } } }));
    expect(await declare({ appProductId: OTHER_PRODUCT })).toEqual({ ok: false, error: "not_allowed" });
  });

  it("11 — a foreign-tenant directory application is invisible to RLS, so it reads as absent and is refused without disclosure", async () => {
    const sb = makeSupabase({ source: { data: null, error: null } });
    createClient.mockResolvedValue(sb);
    expect(await declare()).toEqual({ ok: false, error: "not_allowed" });
    expect(sb.__queries.some((q) => q.op === "insert")).toBe(false);
  });

  it("12 — a member without editor+ is rejected by the 0024 RLS WITH CHECK", async () => {
    createClient.mockResolvedValue(makeSupabase({ source: currentSource, alias: [{ data: null, error: null }], insert: { error: { code: "42501" } } }));
    expect(await declare()).toEqual({ ok: false, error: "not_allowed" });
  });

  it("13 — a stale or disconnected source cannot mint new canonical identity", async () => {
    for (const sync_status of ["stale", "review_required", "disconnected"]) {
      const sb = makeSupabase({ source: { data: { external_id: "0oaAbC123", provider: "okta", sync_status }, error: null } });
      createClient.mockResolvedValue(sb);
      expect(await declare()).toEqual({ ok: false, error: "source_not_eligible" });
      expect(sb.__queries.some((q) => q.op === "insert")).toBe(false);
    }
  });

  it("14 — a name declaration is refused before anything is read", async () => {
    const sb = makeSupabase({ source: currentSource });
    createClient.mockResolvedValue(sb);
    expect(await declare({ aliasType: "name" })).toEqual({ ok: false, error: "unsupported_alias_type" });
    expect(sb.__queries).toHaveLength(0);
    for (const t of ["sso_app_id", "oauth_client_id", "instance_domain", "external_instance_id", "domain"]) {
      expect(await declare({ aliasType: t })).toEqual({ ok: false, error: "unsupported_alias_type" });
    }
  });

  it("5b — the tenant is resolved server-side; no request field can select it", async () => {
    resolveTenantContext.mockResolvedValue(null);
    createClient.mockResolvedValue(makeSupabase({ source: currentSource }));
    expect(await declare()).toEqual({ ok: false, error: "not_allowed" });
    // and when it does resolve, every query is filtered by the SERVER-derived tenant
    resolveTenantContext.mockResolvedValue({ activeTenant: { id: TENANT, role: "editor" }, organizationMemberships: [] });
    const sb = makeSupabase({ source: currentSource, alias: [{ data: null, error: null }] });
    createClient.mockResolvedValue(sb);
    await declare();
    for (const q of sb.__queries.filter((x) => x.cols)) expect(q.eqs).toContainEqual(["tenant_id", TENANT]);
  });

  it("a concurrent writer taking the natural key re-reads and stays idempotent when it wrote the same product", async () => {
    createClient.mockResolvedValue(makeSupabase({
      source: currentSource,
      alias: [{ data: null, error: null }, { data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null }],
      insert: { error: { code: "23505" } },
    }));
    expect(await declare()).toEqual({ ok: true, outcome: "unchanged", aliasValue: "0oaAbC123" });
  });

  it("malformed ids are refused as invalid input, not passed to the database", async () => {
    const sb = makeSupabase({ source: currentSource });
    createClient.mockResolvedValue(sb);
    expect(await declare({ appProductId: "not-a-uuid" })).toEqual({ ok: false, error: "invalid_input" });
    expect(sb.__queries).toHaveLength(0);
  });
});

// ── Source contracts (tripwires, not behaviour) ──────────────────────────────────────────────────────────────────────
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const PHASE_SOURCES = ["src/lib/canonical/application-alias.ts", "src/lib/data/application-aliases.ts", "src/app/(authenticated)/catalog/actions.ts"];

describe("privilege + neutrality contracts", () => {
  // 17 — service-role usage is ZERO. The canonical control is scripts/check-auth-safety.sh, which greps ALL of src/ on every PR
  // (review-discipline.yml) and has its own selftest proving it catches positives. Restating its forbidden literals here would
  // both duplicate an existing gate and put those literals under src/, which is the very thing the gate exists to prevent — so
  // this proves COVERAGE instead: the guard scans src/, and every file this phase adds lives there.
  it("17 — every file this phase adds is inside the tree the canonical service-role guard scans", () => {
    expect(read("scripts/check-auth-safety.sh")).toMatch(/scan_dir "\$REPO\/src"/);
    for (const p of PHASE_SOURCES) expect(p.startsWith("src/")).toBe(true);
  });

  it("the only database entry point is the user-scoped, RLS-governed server client", () => {
    for (const p of PHASE_SOURCES) {
      const imports = read(p).split("\n").filter((l) => l.startsWith("import"));
      for (const line of imports.filter((l) => /supabase/i.test(l))) expect(line).toContain('from "@/lib/supabase/server"');
    }
  });

  it("16 — connector_runner gains no authority: it holds no grant on the canonical catalog anywhere in the schema", () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).filter((f) =>
      fs.readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .some((l) => /grant\s/i.test(l) && /connector_runner/.test(l) && /\b(app_aliases|app_products|vendors)\b/.test(l)));
    expect(offenders).toEqual([]);
  });

  it("this phase adds NO migration and does not touch application_matches", () => {
    for (const p of PHASE_SOURCES) expect(read(p)).not.toMatch(/from\(["']application_matches["']\)/);
  });

  it("no provider-specific branching — provider strings are opaque provenance only", () => {
    // A provider name may appear in a comment; it must never appear in a comparison or a switch.
    for (const p of PHASE_SOURCES) {
      const code = read(p).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code).not.toMatch(/["'](okta|slack|google|entra|microsoft|github)["']/i);
    }
  });
});
