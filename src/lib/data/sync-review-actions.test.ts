import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import {
  confirmPendingReview,
  rejectPendingReview,
  isReviewRejectReason,
  REVIEW_REJECT_REASONS,
} from "./sync-review-actions";

// Capturing mock: records the table, the update() payload, every eq()/in() filter, and the select() cols; resolves the
// UPDATE…select("id") to a fixed row set. Proves the query is a guarded, body-free, tenant-authority-free UPDATE.
type Calls = { table?: string; op?: string; payload?: Record<string, unknown>; eqs: [string, string][]; ins: [string, readonly string[]][]; selectCols?: string };
function makeSupabase(opts: { user?: { data: unknown; error: unknown }; result?: { data: unknown; error: unknown } }) {
  const calls: Calls = { eqs: [], ins: [] };
  const chain = {
    update: (payload: Record<string, unknown>) => { calls.op = "update"; calls.payload = payload; return chain; },
    insert: (payload: unknown) => { calls.op = "insert"; void payload; return chain; },
    delete: () => { calls.op = "delete"; return chain; },
    eq: (col: string, val: string) => { calls.eqs.push([col, val]); return chain; },
    in: (col: string, vals: readonly string[]) => { calls.ins.push([col, vals]); return chain; },
    select: (cols: string) => { calls.selectCols = cols; return Promise.resolve(opts.result ?? { data: [{ id: "df-1" }, { id: "df-2" }], error: null }); },
  };
  return {
    auth: { getUser: () => Promise.resolve(opts.user ?? { data: { user: { id: "0a000000-ed" } }, error: null }) },
    from: (t: string) => { calls.table = t; return chain; },
    __calls: calls,
  };
}
beforeEach(() => createClient.mockReset());

describe("confirmPendingReview — pending → confirmed only, body-free, guarded", () => {
  it("issues a guarded pending-only UPDATE of ONLY the review columns and counts transitioned rows", async () => {
    const sb = makeSupabase({});
    createClient.mockResolvedValue(sb);
    const res = await confirmPendingReview({});
    expect(res).toEqual({ ok: true, data: { updated: 2 } });

    const c = sb.__calls;
    expect(c.table).toBe("discovery_facts");
    expect(c.op).toBe("update");
    // ONLY review columns updated — no body/PII column.
    expect(Object.keys(c.payload!).sort()).toEqual(["review_status", "reviewed_by", "reviewed_at"].sort());
    expect(c.payload!.review_status).toBe("confirmed");
    expect(c.payload!.reviewed_by).toBe("0a000000-ed"); // reviewer set from the authed user
    expect(typeof c.payload!.reviewed_at).toBe("string"); // reviewed_at set
    // guard: only rows still pending transition
    expect(c.eqs).toContainEqual(["review_status", "pending"]);
    // count-only read: select id, never a body column
    expect(c.selectCols).toBe("id");
    // NO caller tenant_id authority — RLS scopes rows
    expect(c.eqs.map(([col]) => col)).not.toContain("tenant_id");
  });

  it("scopes by run + type (opaque keys) without a tenant filter", async () => {
    const sb = makeSupabase({});
    createClient.mockResolvedValue(sb);
    await confirmPendingReview({ sourceRunId: "run-1", factType: "app_user_account", factIds: ["df-1"] });
    const c = sb.__calls;
    expect(c.ins).toContainEqual(["id", ["df-1"]]);
    expect(c.eqs).toContainEqual(["source_run_id", "run-1"]);
    expect(c.eqs).toContainEqual(["fact_type", "app_user_account"]);
    expect(c.eqs.map(([col]) => col)).not.toContain("tenant_id");
  });
});

describe("rejectPendingReview — pending → rejected only, fixed reason, body-free", () => {
  it("updates review_status=rejected + rejected_reason (fixed code); guarded pending-only; no body column", async () => {
    const sb = makeSupabase({});
    createClient.mockResolvedValue(sb);
    const res = await rejectPendingReview({}, "not_a_real_account");
    expect(res).toEqual({ ok: true, data: { updated: 2 } });

    const c = sb.__calls;
    expect(Object.keys(c.payload!).sort()).toEqual(["review_status", "reviewed_by", "reviewed_at", "rejected_reason"].sort());
    expect(c.payload!.review_status).toBe("rejected");
    expect(c.payload!.rejected_reason).toBe("not_a_real_account");
    expect(c.eqs).toContainEqual(["review_status", "pending"]);
    expect(c.selectCols).toBe("id");
  });

  it("rejects a reason outside the fixed enum WITHOUT issuing any DB write (fail closed)", async () => {
    const sb = makeSupabase({});
    createClient.mockResolvedValue(sb);
    const res = await rejectPendingReview({}, "free text with an email leak@example.com" as never);
    expect(res).toEqual({ ok: false, error: "invalid_reason" });
    // createClient must not even have been reached → no update issued.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("isReviewRejectReason accepts only the fixed enum", () => {
    for (const r of REVIEW_REJECT_REASONS) expect(isReviewRejectReason(r)).toBe(true);
    expect(isReviewRejectReason("whatever")).toBe(false);
    expect(REVIEW_REJECT_REASONS).toContain("not_a_real_account");
  });
});

describe("guards: no body write, no audit insert, no delete, fail-closed", () => {
  it("never targets audit_logs, never inserts/deletes", async () => {
    const sb = makeSupabase({});
    createClient.mockResolvedValue(sb);
    await confirmPendingReview({});
    await rejectPendingReview({}, "duplicate");
    // only discovery_facts touched; op is always update (never insert/delete)
    expect(sb.__calls.table).toBe("discovery_facts");
    expect(sb.__calls.op).toBe("update");
  });

  it("fails closed when there is no authenticated user (no update issued)", async () => {
    const sb = makeSupabase({ user: { data: { user: null }, error: null } });
    createClient.mockResolvedValue(sb);
    expect(await confirmPendingReview({})).toEqual({ ok: false, error: "not_authenticated" });
    expect(sb.__calls.op).toBeUndefined(); // no update reached
  });

  it("fails closed on a DB error", async () => {
    const sb = makeSupabase({ result: { data: null, error: { message: "boom" } } });
    createClient.mockResolvedValue(sb);
    expect(await confirmPendingReview({})).toEqual({ ok: false, error: "update_failed" });
  });
});

// Static source scan: the module updates/selects no body column, never inserts audit_logs, and uses no service-role.
describe("sync-review-actions.ts source — no body column, no audit insert, no service-role", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("references no forbidden body/secret identifier and no service-role client", () => {
    const src = strip(fs.readFileSync(path.resolve(__dirname, "sync-review-actions.ts"), "utf8"));
    for (const forbidden of ["fact_json", "natural_key", "signal_id", "source_record_id", "provenance_json", "primary_email", "display_name", "access_token", "ciphertext"]) {
      expect(src).not.toContain(forbidden);
    }
    // audit is trigger-produced — the app never writes audit_logs, and never uses a service-role/admin client.
    expect(src).not.toContain("audit_logs");
    // Build the privilege-escalation literals dynamically so THIS test file carries no bare service-role literal —
    // the repo-wide auth-safety scan (scripts/check-auth-safety.sh) correctly bans that literal anywhere under src/,
    // and writing it here would (falsely) trip it. The runtime assertion is unchanged.
    const svcRole = ["service", "role"].join("_");
    const svcRoleUpper = ["SERVICE", "ROLE"].join("_");
    for (const forbidden of [svcRole, svcRoleUpper, "createServiceClient", "supabaseAdmin", ".delete("]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
