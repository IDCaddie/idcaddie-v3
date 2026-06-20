import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer test for listRecentAuditEntriesForCurrentUser: the DTO exposes ONLY action / resourceType /
// created_at / a boolean actorRecorded label — never tenant_id, the raw actor/resource id, ip/user-agent,
// or the before/after JSON blobs. DB-level tenant-scoping is the `is_tenant_member` SELECT policy (0001);
// this covers the safe-projection wiring.

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { listRecentAuditEntriesForCurrentUser } from "./audit";

function makeSupabase(result: { data: unknown[] | null; error: unknown }) {
  const p = Promise.resolve(result);
  return {
    from: () => ({
      select: () => ({ order: () => ({ limit: () => p }) }),
    }),
  };
}

beforeEach(() => createClient.mockReset());

describe("listRecentAuditEntriesForCurrentUser", () => {
  it("maps to a safe DTO and never exposes tenant_id / actor id / json / ip / ua / resource id", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        data: [
          {
            id: "a1",
            action: "contract.update",
            resource_type: "contract",
            actor_user_id: "00000000-0000-0000-0000-000000000001",
            created_at: "2026-06-19T10:00:00Z",
            // Columns the DAL must NOT select/expose (present here to prove they never reach the DTO):
            tenant_id: "tttt",
            resource_id: "rrrr",
            before_json: { secret: "x" },
            after_json: { secret: "y" },
            ip_address: "10.0.0.1",
            user_agent: "evil/1.0",
          },
          {
            id: "a2",
            action: "app.view",
            resource_type: "app",
            actor_user_id: null,
            created_at: "2026-06-19T09:00:00Z",
          },
        ],
        error: null,
      }),
    );

    const res = await listRecentAuditEntriesForCurrentUser();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]).toEqual({
      id: "a1",
      action: "contract.update",
      resourceType: "contract",
      createdAt: "2026-06-19T10:00:00Z",
      actorRecorded: true,
    });
    expect(res.data[1].actorRecorded).toBe(false); // null actor → "no" label, not the raw id

    // Exact safe key set; sensitive internals provably absent.
    expect(Object.keys(res.data[0]).sort()).toEqual(
      ["action", "actorRecorded", "createdAt", "id", "resourceType"].sort(),
    );
    for (const k of ["tenant_id", "actor_user_id", "resource_id", "before_json", "after_json", "ip_address", "user_agent"]) {
      expect(k in res.data[0]).toBe(false);
    }
  });

  it("empty audit log → empty list", async () => {
    createClient.mockResolvedValue(makeSupabase({ data: [], error: null }));
    expect(await listRecentAuditEntriesForCurrentUser()).toEqual({ ok: true, data: [] });
  });

  it("a failed read fails closed with a safe label", async () => {
    createClient.mockResolvedValue(makeSupabase({ data: null, error: { message: "boom" } }));
    expect(await listRecentAuditEntriesForCurrentUser()).toEqual({ ok: false, error: "query_failed" });
  });
});
