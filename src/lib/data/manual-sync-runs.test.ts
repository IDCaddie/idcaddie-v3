import { describe, it, expect, vi, beforeEach } from "vitest";

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { getLatestSlackSyncRunForCurrentTenant } from "./manual-sync-runs";

// `.eq('source','slack').order().limit().maybeSingle()` — RLS scopes the rows; this covers the safe-DTO mapping.
function makeSupabase(result: { data: unknown; error: unknown }) {
  const chain = { eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: () => Promise.resolve(result) };
  return { from: () => ({ select: () => chain }) };
}
beforeEach(() => createClient.mockReset());

describe("getLatestSlackSyncRunForCurrentTenant", () => {
  it("maps the latest run to a safe DTO (status/counts/timestamps/safe error only)", async () => {
    createClient.mockResolvedValue(makeSupabase({
      data: { status: "succeeded", started_at: "2026-06-27T00:00:00Z", finished_at: "2026-06-27T00:00:05Z", error_code: null, failed_stage: null,
        users_fetched: 1, facts_emitted: 6, facts_rejected: 0, app_users_written: 1, people_written: 1, matches_written: 1, match_conflicts: 0, skipped: 2 },
      error: null,
    }));
    const res = await getLatestSlackSyncRunForCurrentTenant();
    expect(res).toEqual({ ok: true, data: expect.objectContaining({ status: "succeeded", usersFetched: 1, matchesWritten: 1, finishedAt: "2026-06-27T00:00:05Z" }) });
  });

  it("returns null data when the tenant has no runs (empty state)", async () => {
    createClient.mockResolvedValue(makeSupabase({ data: null, error: null }));
    expect(await getLatestSlackSyncRunForCurrentTenant()).toEqual({ ok: true, data: null });
  });

  it("a failed read collapses to a safe query_failed label", async () => {
    createClient.mockResolvedValue(makeSupabase({ data: null, error: { message: "boom" } }));
    expect(await getLatestSlackSyncRunForCurrentTenant()).toEqual({ ok: false, error: "query_failed" });
  });
});
