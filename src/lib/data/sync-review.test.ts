import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { getSyncReviewCounts, syncReviewLeadLabel, syncReviewHasAwaiting, getSyncReviewPendingGroups } from "./sync-review";

// Capturing mock: records every .from(table).select(cols, opts).eq(col, val); resolves the count keyed by the eq VALUE
// (review_status value or fact_type value). Proves the query is count-only and never selects a body column.
type Call = { table: string; cols: unknown; opts: unknown; eqs: [string, string][] };
function makeSupabase(byKey: Record<string, { count?: number; error?: unknown }>, calls: Call[]) {
  return {
    from: (table: string) => ({
      select: (cols: unknown, opts: unknown) => {
        const rec: Call = { table, cols, opts, eqs: [] };
        calls.push(rec);
        return {
          eq: (col: string, val: string) => {
            rec.eqs.push([col, val]);
            const r = byKey[val] ?? { count: 0, error: null };
            return Promise.resolve({ count: r.count ?? 0, error: r.error ?? null });
          },
        };
      },
    }),
  };
}
beforeEach(() => createClient.mockReset());

describe("getSyncReviewCounts — count-only, no bodies, fails closed", () => {
  it("returns aggregate counts (total sums all review_status) and the fact_type count", async () => {
    const calls: Call[] = [];
    createClient.mockResolvedValue(
      makeSupabase({ pending: { count: 3 }, needs_review: { count: 0 }, confirmed: { count: 1 }, rejected: { count: 2 }, auto: { count: 4 }, app_user_account: { count: 3 } }, calls),
    );
    const res = await getSyncReviewCounts();
    expect(res).toEqual({ ok: true, data: { pending: 3, needsReview: 0, confirmed: 1, rejected: 2, total: 10, appUserAccounts: 3 } });
  });

  it("every query is COUNT-ONLY (head:true, count:exact, selects only 'id') and never a body column", async () => {
    const calls: Call[] = [];
    createClient.mockResolvedValue(makeSupabase({}, calls));
    await getSyncReviewCounts();

    expect(calls.length).toBe(6); // 5 review_status + 1 fact_type
    for (const c of calls) {
      expect(c.table).toBe("discovery_facts");
      expect(c.cols).toBe("id"); // NEVER fact_json / natural_key / signal_id / provenance / a body column
      expect(c.opts).toEqual({ count: "exact", head: true }); // zero rows transferred
    }
    // filters use only the safe enums review_status + fact_type — never a caller-supplied tenant_id (RLS scopes rows)
    const eqCols = calls.flatMap((c) => c.eqs.map(([col]) => col));
    expect(new Set(eqCols)).toEqual(new Set(["review_status", "fact_type"]));
    expect(eqCols).not.toContain("tenant_id");
  });

  it("uses the user-scoped server client (createClient) — the RLS/user path, not a caller tenant filter", async () => {
    const calls: Call[] = [];
    createClient.mockResolvedValue(makeSupabase({ pending: { count: 3 } }, calls));
    await getSyncReviewCounts();
    expect(createClient).toHaveBeenCalledTimes(1); // the anon, RLS-scoped server client
  });

  it("a failed count fails closed with a safe query_failed label", async () => {
    const calls: Call[] = [];
    createClient.mockResolvedValue(makeSupabase({ pending: { error: { message: "boom" } } }, calls));
    expect(await getSyncReviewCounts()).toEqual({ ok: false, error: "query_failed" });
  });
});

describe("pure label/count helpers", () => {
  it("syncReviewLeadLabel pluralizes", () => {
    expect(syncReviewLeadLabel({ pending: 3 })).toBe("3 items pending review from the last sync");
    expect(syncReviewLeadLabel({ pending: 1 })).toBe("1 item pending review from the last sync");
    expect(syncReviewLeadLabel({ pending: 0 })).toBe("0 items pending review from the last sync");
  });
  it("syncReviewHasAwaiting = pending + needs_review > 0", () => {
    expect(syncReviewHasAwaiting({ pending: 0, needsReview: 0 })).toBe(false);
    expect(syncReviewHasAwaiting({ pending: 3, needsReview: 0 })).toBe(true);
    expect(syncReviewHasAwaiting({ pending: 0, needsReview: 2 })).toBe(true);
  });
});

// Static safety scan: the DAL may name the table (it queries it), but must never SELECT a body/PII/secret column; the
// connectors PAGE must contain NONE of the leak-scan forbidden literals (discovery_facts / fact_json / connector_secret).
describe("sync-review DAL + connectors page never leak a body/secret column", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("DAL (comments stripped) selects no body column; page has no forbidden literal", () => {
    const dal = strip(fs.readFileSync(path.resolve(__dirname, "sync-review.ts"), "utf8"));
    const page = strip(fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "(authenticated)", "connectors", "page.tsx"), "utf8"));
    for (const forbidden of ["fact_json", "natural_key", "signal_id", "provenance_json", "primary_email", "display_name", "access_token", "ciphertext", "dek_wrapped", "aead_"]) {
      expect(dal).not.toContain(forbidden);
    }
    for (const forbidden of ["discovery_facts", "fact_json", "connector_secret"]) {
      expect(page).not.toContain(forbidden);
    }
  });
});

// Grouped read: selects ONLY safe metadata columns for pending rows and groups them — never a body column.
function makeGroupsSupabase(rows: unknown[] | null, error: unknown, cap: { cols?: unknown; eqs: [string, string][] }) {
  return {
    from: () => ({
      select: (cols: unknown) => {
        cap.cols = cols;
        return { eq: (col: string, val: string) => { cap.eqs.push([col, val]); return Promise.resolve({ data: rows, error }); } };
      },
    }),
  };
}

describe("getSyncReviewPendingGroups — count-only batches, safe columns, fail-closed", () => {
  it("selects only safe metadata (no body column), guards pending, no tenant filter, and groups by run+type+provider", async () => {
    const cap: { cols?: unknown; eqs: [string, string][] } = { eqs: [] };
    createClient.mockResolvedValue(makeGroupsSupabase(
      [
        { source_run_id: "run-1", fact_type: "app_user_account", source_provider: "slack", created_at: "2026-07-10T01:00:00Z" },
        { source_run_id: "run-1", fact_type: "app_user_account", source_provider: "slack", created_at: "2026-07-10T02:00:00Z" },
        { source_run_id: "run-1", fact_type: "group", source_provider: "slack", created_at: "2026-07-10T03:00:00Z" },
        { source_run_id: "run-2", fact_type: "app_user_account", source_provider: "okta", created_at: "2026-07-09T00:00:00Z" },
      ],
      null,
      cap,
    ));
    const res = await getSyncReviewPendingGroups();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(cap.cols).toBe("source_run_id, fact_type, source_provider, created_at"); // never a body column
    expect(String(cap.cols)).not.toMatch(/fact_json|natural_key|signal_id|source_record_id|provenance_json/);
    expect(cap.eqs).toContainEqual(["review_status", "pending"]);
    expect(cap.eqs.map(([c]) => c)).not.toContain("tenant_id");
    expect(res.data).toHaveLength(3); // (run1,users) (run1,group) (run2,users)
    const run1users = res.data.find((g) => g.sourceRunId === "run-1" && g.factType === "app_user_account");
    expect(run1users?.pending).toBe(2);
    expect(run1users?.firstSeen).toBe("2026-07-10T01:00:00Z");
    expect(run1users?.lastSeen).toBe("2026-07-10T02:00:00Z");
  });

  it("fails closed on a DB error", async () => {
    createClient.mockResolvedValue(makeGroupsSupabase(null, { message: "boom" }, { eqs: [] }));
    expect(await getSyncReviewPendingGroups()).toEqual({ ok: false, error: "query_failed" });
  });
});
