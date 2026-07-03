import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { getLatestSlackSyncRunForCurrentTenant, getSlackAppUserPresenceCountsForCurrentTenant } from "./manual-sync-runs";

// `.eq('source','slack').order().limit().maybeSingle()` — RLS scopes the rows; this covers the safe-DTO mapping.
function makeSupabase(result: { data: unknown; error: unknown }) {
  const chain = { eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: () => Promise.resolve(result) };
  return { from: () => ({ select: () => chain }) };
}
// per-table mock for the presence counts: apps.select(...).not().ilike() → {data:appRows}; app_users.select(...,{head}).in().eq() → {count}.
function makePresenceSupabase(apps: { data?: unknown; error?: unknown }, counts: { active?: { count?: number; error?: unknown }; stale?: { count?: number; error?: unknown } }) {
  const appsChain = { not: () => appsChain, ilike: () => Promise.resolve({ data: apps.data ?? null, error: apps.error ?? null }) };
  const auChain = (status: string) => ({ in: () => auChain(status), eq: (_c: string, v: string) => Promise.resolve(v === "active" ? { count: counts.active?.count ?? 0, error: counts.active?.error ?? null } : { count: counts.stale?.count ?? 0, error: counts.stale?.error ?? null }) });
  return { from: (t: string) => ({ select: () => (t === "apps" ? appsChain : auChain("")) }) };
}
beforeEach(() => createClient.mockReset());

describe("getLatestSlackSyncRunForCurrentTenant", () => {
  it("maps the latest run to a safe DTO (status/counts/timestamps/safe error + 0040 stale count)", async () => {
    createClient.mockResolvedValue(makeSupabase({
      data: { status: "succeeded", started_at: "2026-06-27T00:00:00Z", finished_at: "2026-06-27T00:00:05Z", error_code: null, failed_stage: null,
        users_fetched: 1, facts_emitted: 6, facts_rejected: 0, app_users_written: 1, people_written: 1, matches_written: 1, match_conflicts: 0, skipped: 2, app_users_marked_stale: 3 },
      error: null,
    }));
    const res = await getLatestSlackSyncRunForCurrentTenant();
    expect(res).toEqual({ ok: true, data: expect.objectContaining({ status: "succeeded", usersFetched: 1, matchesWritten: 1, finishedAt: "2026-06-27T00:00:05Z", appUsersMarkedStale: 3 }) });
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

describe("getSlackAppUserPresenceCountsForCurrentTenant", () => {
  it("counts active/stale app_users for the tenant's Slack app(s)", async () => {
    createClient.mockResolvedValue(makePresenceSupabase({ data: [{ id: "app-1" }] }, { active: { count: 5 }, stale: { count: 2 } }));
    expect(await getSlackAppUserPresenceCountsForCurrentTenant()).toEqual({ ok: true, data: { active: 5, stale: 2 } });
  });

  it("returns {active:0, stale:0} when the tenant has no Slack app (empty state)", async () => {
    createClient.mockResolvedValue(makePresenceSupabase({ data: [] }, {}));
    expect(await getSlackAppUserPresenceCountsForCurrentTenant()).toEqual({ ok: true, data: { active: 0, stale: 0 } });
  });

  it("a failed apps read collapses to query_failed", async () => {
    createClient.mockResolvedValue(makePresenceSupabase({ error: { message: "boom" } }, {}));
    expect(await getSlackAppUserPresenceCountsForCurrentTenant()).toEqual({ ok: false, error: "query_failed" });
  });

  it("a failed count read collapses to query_failed", async () => {
    createClient.mockResolvedValue(makePresenceSupabase({ data: [{ id: "app-1" }] }, { active: { error: { message: "boom" } }, stale: { count: 0 } }));
    expect(await getSlackAppUserPresenceCountsForCurrentTenant()).toEqual({ ok: false, error: "query_failed" });
  });
});

// Static safety scan: the sync-status DAL + the connectors page must never SELECT/render a secret/PII column.
describe("sync-status DAL + connectors page never reference a secret/PII column", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("manual-sync-runs.ts + connectors page reference no token/secret/PII column string", () => {
    const dal = strip(fs.readFileSync(path.resolve(__dirname, "manual-sync-runs.ts"), "utf8"));
    const page = strip(fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "(authenticated)", "connectors", "page.tsx"), "utf8"));
    // surgical identifiers (real secret/PII columns + token shapes), NOT English words that appear in reassurance copy.
    // (the service-role literal is intentionally omitted — scripts/check-auth-safety.sh already forbids it repo-wide.)
    for (const forbidden of ["connector_secret", "raw_payload", "rawPayload", "access_token", "ciphertext", "dek_wrapped", "aead_", "primary_email", "display_name", "xoxb", "Bearer "]) {
      expect(dal).not.toContain(forbidden);
      expect(page).not.toContain(forbidden);
    }
  });
  it("the connectors page is a read-only server component — no interactive trigger/action element", () => {
    const raw = fs.readFileSync(path.resolve(__dirname, "..", "..", "app", "(authenticated)", "connectors", "page.tsx"), "utf8");
    // "use client" / onClick / <form> / <button> / action= would all imply an actionable surface — none may appear.
    for (const banned of ['"use client"', "onClick", "<form", "<button", "action="]) expect(raw).not.toContain(banned);
    // the disabled "Not built yet" capability chips are allowed (they are static spans, not actions).
    expect(raw).toContain("Not built yet");
  });
});
