import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import {
  classifyAppUserAccountReadiness,
  getAppUserAccountPromotionReadiness,
  type PromotionReadinessCounts,
} from "./promotion-readiness";

// ── Test data helpers ────────────────────────────────────────────────────────────────────────────────────────────
const fact = (o: Partial<{ ext: string; suid: string; email: string; ikey: string }> = {}) => ({
  ext: o.ext ?? null, suid: o.suid ?? null, email: o.email ?? null, ikey: o.ikey ?? null,
});
const app = (id: string, key: string | null) => ({ id, external_instance_id: key });
const appUser = (app_id: string, external_user_id: string | null, email: string | null = null) => ({ app_id, external_user_id, email });

// sum of the five buckets must always equal total (the invariant the DAL cross-checks).
const sumOk = (c: PromotionReadinessCounts) =>
  c.ready + c.alreadyRepresented + c.conflict + c.missingRequired + c.unsupported === c.total;

// ── PURE classifier: deterministic precedence (docs/70 §4) ───────────────────────────────────────────────────────
describe("classifyAppUserAccountReadiness — deterministic precedence, counts only", () => {
  const APPS = [app("app1", "T1")]; // one resolvable instance key T1 → app1

  it("zero rows → all buckets zero", () => {
    const c = classifyAppUserAccountReadiness([], [], []);
    expect(c).toEqual({ ready: 0, alreadyRepresented: 0, conflict: 0, missingRequired: 0, unsupported: 0, total: 0 });
  });

  it("READY: has external anchor, app resolves, not represented, no email collision", () => {
    const c = classifyAppUserAccountReadiness([fact({ ext: "U1", ikey: "T1", email: "a@x.com" })], APPS, []);
    expect(c.ready).toBe(1); expect(sumOk(c)).toBe(true);
  });

  it("READY via source_user_id fallback when app_user_external_id is absent", () => {
    const c = classifyAppUserAccountReadiness([fact({ suid: "U9", ikey: "T1" })], APPS, []);
    expect(c.ready).toBe(1);
  });

  it("ALREADY-REPRESENTED: exact (app_id, external_user_id) already in app_users → idempotent no-op", () => {
    const c = classifyAppUserAccountReadiness([fact({ ext: "U1", ikey: "T1" })], APPS, [appUser("app1", "U1")]);
    expect(c).toMatchObject({ alreadyRepresented: 1, ready: 0 }); expect(sumOk(c)).toBe(true);
  });

  it("CONFLICT: same (app_id, lower(email)) held by a DIFFERENT external_user_id → duplicate email", () => {
    const c = classifyAppUserAccountReadiness(
      [fact({ ext: "U_new", ikey: "T1", email: "Dup@X.com" })],
      APPS,
      [appUser("app1", "U_old", "dup@x.com")], // case-insensitive match, different ext id
    );
    expect(c).toMatchObject({ conflict: 1, ready: 0, alreadyRepresented: 0 });
  });

  it("precedence: already-represented WINS over an email collision (exact natural key checked first)", () => {
    const c = classifyAppUserAccountReadiness(
      [fact({ ext: "U1", ikey: "T1", email: "dup@x.com" })],
      APPS,
      [appUser("app1", "U1", "other@x.com"), appUser("app1", "U2", "dup@x.com")],
    );
    expect(c).toMatchObject({ alreadyRepresented: 1, conflict: 0 });
  });

  it("MISSING-REQUIRED: no external anchor (email-only is NOT sufficient for app_users)", () => {
    const c = classifyAppUserAccountReadiness([fact({ email: "only@x.com", ikey: "T1" })], APPS, []);
    expect(c).toMatchObject({ missingRequired: 1, ready: 0 });
  });

  it("UNSUPPORTED: has anchor but no app_instance_key", () => {
    const c = classifyAppUserAccountReadiness([fact({ ext: "U1" })], APPS, []);
    expect(c).toMatchObject({ unsupported: 1 });
  });

  it("UNSUPPORTED: app_instance_key resolves to no apps row (app creation out of scope)", () => {
    const c = classifyAppUserAccountReadiness([fact({ ext: "U1", ikey: "T_unknown" })], APPS, []);
    expect(c).toMatchObject({ unsupported: 1 });
  });

  it("no fuzzy matching: a near-but-not-exact external id is NOT already-represented (→ ready)", () => {
    const c = classifyAppUserAccountReadiness([fact({ ext: "U1", ikey: "T1" })], APPS, [appUser("app1", "U10")]);
    expect(c).toMatchObject({ ready: 1, alreadyRepresented: 0 });
  });

  it("no cross-app collision: same external id under a DIFFERENT app is not represented (→ ready)", () => {
    const c = classifyAppUserAccountReadiness(
      [fact({ ext: "U1", ikey: "T1" })],
      [app("app1", "T1"), app("app2", "T2")],
      [appUser("app2", "U1")], // U1 exists but under app2, not app1
    );
    expect(c).toMatchObject({ ready: 1 });
  });

  it("mixed batch tallies each bucket and preserves the sum invariant", () => {
    const c = classifyAppUserAccountReadiness(
      [
        fact({ ext: "R1", ikey: "T1" }), // ready
        fact({ ext: "A1", ikey: "T1" }), // already
        fact({ ext: "C1", ikey: "T1", email: "c@x.com" }), // conflict
        fact({ email: "m@x.com", ikey: "T1" }), // missing
        fact({ ext: "U1" }), // unsupported (no ikey)
      ],
      APPS,
      [appUser("app1", "A1"), appUser("app1", "Cx", "c@x.com")],
    );
    expect(c).toEqual({ ready: 1, alreadyRepresented: 1, conflict: 1, missingRequired: 1, unsupported: 1, total: 5 });
  });
});

// ── DAL: RLS-scoped, confirmed+app_user_account only, counts-only, fail-closed, no writes ─────────────────────────
type TableResult = { data?: unknown[] | null; error?: unknown };
let eqCalls: Record<string, [string, string][]>;
let selectCols: Record<string, string>;
let rpcCalled: boolean;

function makeClient(tables: Record<string, TableResult>) {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: (cols: string) => { selectCols[table] = cols; return b; },
        eq: (col: string, val: string) => { (eqCalls[table] ||= []).push([col, val]); return b; },
        range: () => Promise.resolve(tables[table] ?? { data: [], error: null }),
        insert: () => { throw new Error("WRITE insert() called"); },
        update: () => { throw new Error("WRITE update() called"); },
        upsert: () => { throw new Error("WRITE upsert() called"); },
        delete: () => { throw new Error("WRITE delete() called"); },
      };
      return b;
    },
    rpc: () => { rpcCalled = true; throw new Error("rpc() called"); },
  };
}

beforeEach(() => {
  createClient.mockReset();
  eqCalls = {}; selectCols = {}; rpcCalled = false;
});

describe("getAppUserAccountPromotionReadiness — read-only, RLS-scoped, fail-closed", () => {
  const OK_TABLES = () => ({
    discovery_facts: { data: [{ ext: "U1", suid: null, email: "a@x.com", ikey: "T1" }], error: null },
    apps: { data: [{ id: "app1", external_instance_id: "T1" }], error: null },
    app_users: { data: [], error: null },
  });

  it("applies the confirmed + app_user_account filters and returns counts only (no body fields)", async () => {
    createClient.mockResolvedValue(makeClient(OK_TABLES()));
    const res = await getAppUserAccountPromotionReadiness();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // confirmed-only + app_user_account-only filters are applied on discovery_facts
    expect(eqCalls.discovery_facts).toEqual(expect.arrayContaining([["review_status", "confirmed"], ["fact_type", "app_user_account"]]));
    // pending / rejected / needs_review / auto are NEVER queried (only 'confirmed')
    const statusVals = (eqCalls.discovery_facts || []).filter(([c]) => c === "review_status").map(([, v]) => v);
    expect(statusVals).toEqual(["confirmed"]);
    // no caller-supplied tenant_id anywhere (RLS is the authority)
    for (const eqs of Object.values(eqCalls)) expect(eqs.map(([c]) => c)).not.toContain("tenant_id");
    // the returned object is EXACTLY the six count fields — no row body leaked through
    expect(Object.keys(res.data).sort()).toEqual(["alreadyRepresented", "conflict", "missingRequired", "ready", "total", "unsupported"]);
    expect(res.data).toMatchObject({ ready: 1, total: 1 });
  });

  it("selects only fact_json anchor subfields — never the fact_json blob / natural_key / signal_id / provenance / source_record_id", async () => {
    createClient.mockResolvedValue(makeClient(OK_TABLES()));
    await getAppUserAccountPromotionReadiness();
    const factSel = selectCols.discovery_facts;
    expect(factSel).toContain("fact_json->>app_user_external_id");
    for (const forbidden of ["natural_key", "signal_id", "provenance_json", "source_record_id", "*"]) {
      expect(factSel).not.toContain(forbidden);
    }
    // the fact_json column is only ever dereferenced (->>) — never selected as a whole blob
    expect(/\bfact_json\b(?!->>)/.test(factSel.replace(/fact_json->>/g, ""))).toBe(false);
  });

  it("invokes NO write methods and NO rpc on the happy path", async () => {
    createClient.mockResolvedValue(makeClient(OK_TABLES()));
    await expect(getAppUserAccountPromotionReadiness()).resolves.toMatchObject({ ok: true });
    expect(rpcCalled).toBe(false); // any write/rpc would have thrown inside the mock
  });

  it("fails closed (no partial result, fixed error) when the facts query errors — and logs no values", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createClient.mockResolvedValue(makeClient({ ...OK_TABLES(), discovery_facts: { data: null, error: { message: "boom" } } }));
    const res = await getAppUserAccountPromotionReadiness();
    expect(res).toEqual({ ok: false, error: "query_failed" });
    // the log line is a fixed string carrying NO values (no email/id/table body)
    expect(spy).toHaveBeenCalledWith("[data/promotion-readiness] readiness query failed");
    for (const [args] of spy.mock.calls) expect(String(args)).not.toMatch(/@|boom|U1|T1/);
    spy.mockRestore();
  });

  it("fails closed when the apps or app_users query errors", async () => {
    createClient.mockResolvedValue(makeClient({ ...OK_TABLES(), app_users: { data: null, error: { message: "x" } } }));
    expect(await getAppUserAccountPromotionReadiness()).toEqual({ ok: false, error: "query_failed" });
    createClient.mockResolvedValue(makeClient({ ...OK_TABLES(), apps: { data: null, error: { message: "y" } } }));
    expect(await getAppUserAccountPromotionReadiness()).toEqual({ ok: false, error: "query_failed" });
  });
});

// ── Source discipline: user-scoped client only, no service-role/admin, no write/rpc calls, no body-field logging ──
describe("promotion-readiness source discipline", () => {
  const src = fs.readFileSync(path.join(__dirname, "promotion-readiness.ts"), "utf8");

  it("imports the user-scoped server client and no service-role/admin client", () => {
    expect(src).toContain('from "@/lib/supabase/server"');
    // built by concat so the banned literal never appears in source (check-auth-safety.sh); the assertion is unchanged.
    const svc = ["service", "role"].join("_");
    for (const forbidden of [svc, svc.toUpperCase(), "createAdminClient", "supabaseAdmin", "runnerClient"]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("contains no canonical write / rpc call", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("never console-logs a value (only a fixed string) and never returns a raw body field", () => {
    // the only console call is the fixed fail-closed string
    const logs = src.match(/console\.(error|log|warn|info)\([^)]*\)/g) || [];
    expect(logs).toEqual(['console.error("[data/promotion-readiness] readiness query failed")']);
  });
});
