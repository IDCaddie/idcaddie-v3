import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for listConnectorsForCurrentUser + the pure status helpers (gated vault PR E). The DTO
// exposes ONLY safe Tier-1 metadata — never tenant_id, organization_id, connected_by, health,
// last_sync_at, or anything from connector_secrets. DB-level tenant-scoping is RLS (is_tenant_member);
// this covers the safe-projection + latest-run assembly + fail-closed wiring. Plus a static source scan
// proving the page + data code never reference connector_secrets or secret-shaped columns.

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import {
  listConnectorsForCurrentUser,
  connectorStatusLabel,
  runStatusLabel,
  runCountsLabel,
} from "./connectors";

type TableData = { data: unknown[] | null; error: unknown };

// `.from(table).select(cols).order()` → a promise of {data,error}.
function makeSupabase(byTable: Record<string, TableData>) {
  return {
    from: (table: string) => ({
      select: () => ({ order: () => Promise.resolve(byTable[table] ?? { data: [], error: null }) }),
    }),
  };
}

beforeEach(() => createClient.mockReset());

describe("connectorStatusLabel / runStatusLabel", () => {
  it("formats known connector + run statuses and passes unknown through", () => {
    expect(connectorStatusLabel("active")).toBe("Active");
    expect(connectorStatusLabel("revoked")).toBe("Revoked");
    expect(connectorStatusLabel("weird")).toBe("weird");
    expect(runStatusLabel("succeeded")).toBe("Succeeded");
    expect(runStatusLabel("timed_out")).toBe("Timed out");
    expect(runStatusLabel(null)).toBe("—");
    expect(runStatusLabel(undefined)).toBe("—");
  });
});

describe("runCountsLabel", () => {
  it("summarizes safe counters; hides failed when 0; empty when all null", () => {
    expect(runCountsLabel({ recordsSeen: 3, recordsImported: 3, recordsFailed: 0 })).toBe("3 seen · 3 imported");
    expect(runCountsLabel({ recordsSeen: 3, recordsImported: 1, recordsFailed: 2 })).toBe("3 seen · 1 imported · 2 failed");
    expect(runCountsLabel({ recordsSeen: 0, recordsImported: 0, recordsFailed: 0 })).toBe("0 seen · 0 imported");
    expect(runCountsLabel({ recordsSeen: null, recordsImported: null, recordsFailed: null })).toBe("");
  });
});

describe("listConnectorsForCurrentUser", () => {
  it("assembles a SAFE DTO (no tenant_id/org_id/connected_by/health/last_sync_at) + latest run", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        connectors: {
          data: [
            {
              id: "k1",
              provider: "github",
              display_name: "Acme GitHub",
              status: "active",
              granted_scopes_safe: ["repo:read"],
              created_at: "2026-06-20T00:00:00Z",
              updated_at: "2026-06-21T00:00:00Z",
              // Forbidden columns present in the source row to prove they never reach the DTO:
              tenant_id: "tttt",
              organization_id: "oooo",
              connected_by: "uuuu",
              health: "green",
              last_sync_at: "2026-06-21T00:00:00Z",
            },
          ],
          error: null,
        },
        connector_runs: {
          data: [
            // newest first; the older run for k1 must be ignored (latest wins)
            { connector_id: "k1", status: "succeeded", started_at: "2026-06-21T00:00:00Z", completed_at: "2026-06-21T00:05:00Z", failure_code: null, failure_label: null, records_seen: 10, records_imported: 9, records_failed: 1, created_at: "2026-06-21T00:05:00Z", tenant_id: "tttt" },
            { connector_id: "k1", status: "failed", started_at: "2026-06-20T00:00:00Z", completed_at: "2026-06-20T00:01:00Z", failure_code: "auth_expired", failure_label: "reconnect required", records_seen: 0, records_imported: 0, records_failed: 0, created_at: "2026-06-20T00:01:00Z", tenant_id: "tttt" },
          ],
          error: null,
        },
      }),
    );

    const res = await listConnectorsForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]).toEqual({
      id: "k1",
      provider: "github",
      displayName: "Acme GitHub",
      status: "active",
      safeScopes: ["repo:read"],
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-21T00:00:00Z",
      lastRun: {
        status: "succeeded", // latest run, not the older failed one
        startedAt: "2026-06-21T00:00:00Z",
        completedAt: "2026-06-21T00:05:00Z",
        failureCode: null,
        failureLabel: null,
        recordsSeen: 10,
        recordsImported: 9,
        recordsFailed: 1,
      },
    });

    // Exact safe key set; every forbidden internal provably absent from the serialized DTO.
    expect(Object.keys(res.data[0]).sort()).toEqual(
      ["createdAt", "displayName", "id", "lastRun", "provider", "safeScopes", "status", "updatedAt"].sort(),
    );
    const flat = JSON.stringify(res.data);
    for (const forbidden of ["tenant_id", "tttt", "organization_id", "oooo", "connected_by", "uuuu", "health", "green", "last_sync_at"]) {
      expect(flat).not.toContain(forbidden);
    }
  });

  it("a connector with no runs lists with lastRun null (not erased)", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        connectors: { data: [{ id: "k2", provider: "slack", display_name: null, status: "pending", granted_scopes_safe: null, created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" }], error: null },
        connector_runs: { data: [], error: null },
      }),
    );
    const res = await listConnectorsForCurrentUser();
    expect(res.ok && res.data).toHaveLength(1);
    expect(res.ok && res.data[0].lastRun).toBeNull();
    expect(res.ok && res.data[0].safeScopes).toEqual([]); // null scopes → []
  });

  it("empty connector list → empty result", async () => {
    createClient.mockResolvedValue(makeSupabase({ connectors: { data: [], error: null } }));
    expect(await listConnectorsForCurrentUser()).toEqual({ ok: true, data: [] });
  });

  it("a failed connectors read fails closed with a safe label", async () => {
    createClient.mockResolvedValue(makeSupabase({ connectors: { data: null, error: { message: "boom" } } }));
    expect(await listConnectorsForCurrentUser()).toEqual({ ok: false, error: "query_failed" });
  });

  it("a failed runs read is non-fatal — connectors still list with lastRun null", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        connectors: { data: [{ id: "k3", provider: "jira", display_name: "J", status: "active", granted_scopes_safe: [], created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z" }], error: null },
        connector_runs: { data: null, error: { message: "boom" } },
      }),
    );
    const res = await listConnectorsForCurrentUser();
    expect(res.ok && res.data).toHaveLength(1);
    expect(res.ok && res.data[0].lastRun).toBeNull();
  });
});

// Static guard: the connector page + data code must NEVER reference connector_secrets or any secret-shaped
// column. (The Tier-2 secret store is deny-all; this surface only reads the two Tier-1 metadata tables.)
describe("connector metadata code never touches connector_secrets / secret columns", () => {
  it("connectors.ts + page.tsx contain no connector_secrets query or secret-shaped column string", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dal = fs.readFileSync(path.resolve(__dirname, "connectors.ts"), "utf8");
    const page = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "app", "(authenticated)", "connectors", "page.tsx"),
      "utf8",
    );
    // strip comments so a descriptive comment mentioning the table doesn't trip the scan
    const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const src of [strip(dal), strip(page)]) {
      const secretsTable = ["connector", "secrets"].join("_");
      expect(src).not.toContain(secretsTable); // no connector_secrets query/import
      for (const col of ["ciphertext", "dek_wrapped", "aead_nonce", "wrapped", "access_token", "refresh_token"]) {
        expect(src).not.toContain(col);
      }
      // the only DB tables read are the two Tier-1 metadata tables
      const tables = [...src.matchAll(/\.from\(["']([^"']+)["']\)/g)].map((m) => m[1]);
      for (const t of tables) expect(["connectors", "connector_runs"]).toContain(t);
    }
  });
});
