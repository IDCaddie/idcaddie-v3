import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const createClient = vi.fn();
const accessGate = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("./access-repository", () => ({ accessGate: () => accessGate() }));

import { declareApplicationAlias, resolveApplicationAlias } from "./application-aliases";

const TENANT = "11111111-1111-1111-1111-111111111111";
const DIR_APP = "22222222-2222-2222-2222-222222222222";
const PRODUCT = "33333333-3333-3333-3333-333333333333";

type Q = { table: string; cols?: string; eqs: [string, unknown][]; op?: string };

// Capturing mock. Records the table, selected columns and every filter, so these tests assert what the query is ALLOWED to look
// at — not merely what it returned. That distinction matters here: the mock cannot prove RLS permits the read, which is why the
// permission half is proven by supabase/tests/org_rls_test.sql T46 against a real database instead.
function makeSupabase(result: { data: unknown; error?: { code: string } | null }) {
  const queries: Q[] = [];
  const from = (table: string) => {
    const q: Q = { table, eqs: [] };
    queries.push(q);
    const chain = {
      select: (cols: string) => { q.cols = cols; return chain; },
      eq: (col: string, val: unknown) => { q.eqs.push([col, val]); return chain; },
      maybeSingle: () => Promise.resolve(result),
      insert: () => { q.op = "insert"; return Promise.resolve({ error: null }); },
      update: () => { q.op = "update"; return Promise.resolve({ error: null }); },
    };
    return chain;
  };
  return { from, __queries: queries };
}

const confirmedRow = { data: { app_product_id: PRODUCT, review_status: "confirmed" }, error: null };

beforeEach(() => {
  createClient.mockReset();
  accessGate.mockReset().mockResolvedValue({ ok: true, tenantId: TENANT });
});

describe("resolveApplicationAlias — reads app_aliases ONLY, and only for the given tenant", () => {
  it("an exact deterministic identifier resolves to one product", async () => {
    createClient.mockResolvedValue(makeSupabase(confirmedRow));
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123")).toEqual({ outcome: "resolved", appProductId: PRODUCT });
  });

  it("no alias row is unresolved", async () => {
    createClient.mockResolvedValue(makeSupabase({ data: null, error: null }));
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123")).toEqual({ outcome: "unresolved" });
  });

  it("pending, rejected and auto rows do not resolve", async () => {
    for (const review_status of ["pending", "rejected", "auto"]) {
      createClient.mockResolvedValue(makeSupabase({ data: { app_product_id: PRODUCT, review_status }, error: null }));
      expect(await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123")).toEqual({ outcome: "unresolved" });
    }
  });

  it("a name lookup is refused BEFORE any query reaches the database", async () => {
    const sb = makeSupabase(confirmedRow);
    createClient.mockResolvedValue(sb);
    expect(await resolveApplicationAlias(TENANT, "name", "Slack")).toEqual({ outcome: "unsupported", aliasType: "name" });
    expect(sb.__queries).toHaveLength(0); // the forbidden path does not exist even as a wasted round trip
  });

  it("the query is scoped by tenant and identity, selects only the judgement columns, and touches no other table", async () => {
    const sb = makeSupabase(confirmedRow);
    createClient.mockResolvedValue(sb);
    await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123");
    expect(sb.__queries).toHaveLength(1);
    const q = sb.__queries[0];
    expect(q.table).toBe("app_aliases");
    expect(q.cols).toBe("app_product_id, review_status");
    expect(q.cols).not.toMatch(/name|label/);
    expect(q.eqs).toEqual([["tenant_id", TENANT], ["alias_type", "provider_app_id"], ["alias_value", "0oaAbC123"]]);
  });

  it("performs no write of any kind", async () => {
    const sb = makeSupabase(confirmedRow);
    createClient.mockResolvedValue(sb);
    await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123");
    expect(sb.__queries.some((q) => q.op)).toBe(false);
  });

  it("trims the identifier so a pasted value resolves identically", async () => {
    createClient.mockResolvedValue(makeSupabase(confirmedRow));
    const a = await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123");
    createClient.mockResolvedValue(makeSupabase(confirmedRow));
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "  0oaAbC123 ")).toEqual(a);
  });

  it("an empty identifier is unresolved without querying", async () => {
    const sb = makeSupabase(confirmedRow);
    createClient.mockResolvedValue(sb);
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "   ")).toEqual({ outcome: "unresolved" });
    expect(sb.__queries).toHaveLength(0);
  });

  it("a FAILED read returns null — distinct from `unresolved`, so a caller can never read an outage as 'no product'", async () => {
    createClient.mockResolvedValue(makeSupabase({ data: null, error: { code: "08006" } }));
    expect(await resolveApplicationAlias(TENANT, "provider_app_id", "0oaAbC123")).toBeNull();
  });
});

describe("declareApplicationAlias — two row ids in, one bounded status out", () => {
  const withRpc = (result: { data: unknown; error: unknown }) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    return {
      calls,
      client: { rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve(result); }, from: () => { throw new Error("declaration must not query a table directly"); } },
    };
  };

  it("calls the 0087 command with the SERVER-derived tenant and the caller's two row ids — and no identifier", async () => {
    const { calls, client } = withRpc({ data: { status: "created" }, error: null });
    createClient.mockResolvedValue(client);
    expect(await declareApplicationAlias(DIR_APP, PRODUCT)).toEqual({ ok: true, status: "created" });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("product_declare_application_alias");
    expect(calls[0].args).toEqual({ p_tenant_id: TENANT, p_directory_application_id: DIR_APP, p_app_product_id: PRODUCT });
    // there is no alias_value / alias_type / external_id parameter to pass, by construction
    expect(Object.keys(calls[0].args)).toHaveLength(3);
  });

  it("passes every bounded status through unchanged", async () => {
    for (const status of ["created", "already_confirmed", "conflict", "not_allowed", "source_not_current"]) {
      const { client } = withRpc({ data: { status }, error: null });
      createClient.mockResolvedValue(client);
      expect(await declareApplicationAlias(DIR_APP, PRODUCT)).toEqual({ ok: true, status });
    }
  });

  it("surfaces ONLY the status — an identifier added to the payload can never reach a caller", async () => {
    const { client } = withRpc({ data: { status: "created", externalId: "0oaLEAK" }, error: null });
    createClient.mockResolvedValue(client);
    const r = await declareApplicationAlias(DIR_APP, PRODUCT);
    expect(r).toEqual({ ok: true, status: "created" });
    expect(JSON.stringify(r)).not.toContain("0oaLEAK");
  });

  it("treats an unrecognised status as a failure rather than passing it through", async () => {
    const { client } = withRpc({ data: { status: "definitely_not_a_status" }, error: null });
    createClient.mockResolvedValue(client);
    expect(await declareApplicationAlias(DIR_APP, PRODUCT)).toEqual({ ok: false, error: "query_failed" });
  });

  it("returns a bounded error carrying no DB detail when the command fails", async () => {
    const { client } = withRpc({ data: null, error: { code: "42501", message: "permission denied for table directory_applications" } });
    createClient.mockResolvedValue(client);
    const r = await declareApplicationAlias(DIR_APP, PRODUCT);
    expect(r).toEqual({ ok: false, error: "query_failed" });
    expect(JSON.stringify(r)).not.toMatch(/directory_applications|permission denied|42501/);
  });

  it("short-circuits below owner/admin without calling the command at all", async () => {
    accessGate.mockResolvedValue({ ok: false });
    createClient.mockResolvedValue({ rpc: () => { throw new Error("must not be called"); }, from: () => { throw new Error("must not be called"); } });
    expect(await declareApplicationAlias(DIR_APP, PRODUCT)).toEqual({ ok: false, error: "not_allowed" });
  });
});

// ── Source contracts (tripwires, not behaviour) ──────────────────────────────────────────────────────────────────────
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const PHASE_SOURCES = ["src/lib/canonical/application-alias.ts", "src/lib/data/application-aliases.ts"];

describe("boundary contracts", () => {
  it("no module in this phase reads directory_applications — it is deny-all to authenticated (0057) and has no policy", () => {
    for (const p of PHASE_SOURCES) expect(read(p)).not.toMatch(/from\(["']directory_/);
  });

  it("this phase never touches application_matches, and writes nothing at all", () => {
    for (const p of PHASE_SOURCES) {
      const code = read(p);
      expect(code).not.toMatch(/from\(["']application_matches["']\)/);
      for (const w of [".insert(", ".update(", ".upsert(", ".delete(", '"use server"']) expect(code).not.toContain(w);
      // every mutation goes through the governed 0087 command, never a direct table write
    }
  });

  // Anti-vacuity: the resolver's PERMISSION to read app_aliases is not proven by any mock in this file. It rests on the 0024
  // "members read" policy, whose tenant isolation is proven functionally by the RLS suite against a real database. Pin that
  // dependency here so deleting those assertions cannot silently strip this phase of its only real authorization proof.
  it("the app_aliases RLS read path this resolver depends on is proven by the real-database RLS suite", () => {
    const rls = read("supabase/tests/org_rls_test.sql");
    expect(rls).toContain("T46 Tenant A member reads Tenant A app_alias");
    expect(rls).toContain("T46 Tenant B member must NOT read Tenant A app_alias");
    expect(rls).toContain("app_aliases_tenant_type_value_key"); // the 0026 natural key the single-row assumption rests on
  });

  it("every file this phase adds is inside the tree the canonical service-role guard scans", () => {
    expect(read("scripts/check-auth-safety.sh")).toMatch(/scan_dir "\$REPO\/src"/);
    for (const p of PHASE_SOURCES) expect(p.startsWith("src/")).toBe(true);
  });

  it("the only database entry point is the user-scoped, RLS-governed server client", () => {
    for (const p of PHASE_SOURCES) {
      const imports = read(p).split("\n").filter((l) => l.startsWith("import"));
      for (const line of imports.filter((l) => /supabase/i.test(l))) expect(line).toContain('from "@/lib/supabase/server"');
    }
  });

  it("no provider-specific branching — provider strings are opaque provenance only", () => {
    for (const p of PHASE_SOURCES) {
      const code = read(p).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code).not.toMatch(/["'](okta|slack|google|entra|microsoft|github)["']/i);
    }
  });
});

// ── 0087 migration-text posture (Phase 11B) ──────────────────────────────────────────────────────────────────────────────────
// The SQL harness proves runtime behaviour; this proves the migration TEXT, because a harness can mask a grant that a hosted
// apply would not. Both halves are needed — neither alone is privilege closure.
describe("0087 privilege closure, read off the migration itself", () => {
  const sql = read("supabase/migrations/0087_application_alias_declaration.sql");

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(sql).toMatch(/security definer set search_path = public/);
  });

  it("revokes EXECUTE from public, anon, authenticated AND connector_runner, then grants only authenticated", () => {
    expect(sql).toMatch(/revoke execute on function public\.product_declare_application_alias\(uuid, uuid, uuid\) from public, anon, authenticated, connector_runner;/);
    expect(sql).toMatch(/grant\s+execute on function public\.product_declare_application_alias\(uuid, uuid, uuid\) to authenticated;/);
    // exactly one grant in the whole migration — nothing else gains anything
    expect(sql.match(/^\s*grant\b/gim) ?? []).toHaveLength(1);
  });

  it("adds NO table grant, NO policy, and NO read path to external_id", () => {
    expect(sql).not.toMatch(/grant .* on (table )?public\./i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/alter table/i);
    // external_id is read into a local variable and used to key the alias; it is never selected into a return value
    expect(sql).toMatch(/into v_external_id/);
    expect(sql).not.toMatch(/jsonb_build_object\([^)]*external_id/i);
  });

  it("uses no elevated role and creates no table", () => {
    expect(sql).not.toMatch(/create table/i);
    // The forbidden identifier is assembled rather than written: scripts/check-auth-safety.sh greps ALL of src/ for that literal
    // and has no allowlist, so spelling it here would fail the build. This assertion is NOT a duplicate of that scanner — the
    // scanner covers src/ only and never reads supabase/migrations/, so nothing else proves this migration is clean.
    const elevated = ["service", "role"].join("_");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toContain(elevated);
  });

  it("does not touch application_matches — declaring identity is not matching", () => {
    // comments may DISCUSS it; no statement may reference it
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/application_matches/);
  });
});
