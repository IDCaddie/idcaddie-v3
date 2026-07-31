import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase P0 — the connector status surface must agree with the directory surfaces.
//
// Home, People, Groups and Applications exclude a superseded connector's rows at the RPC layer (migration 0071). If the connector
// status page still described that connector as the tenant's live Okta connection, the product would contradict itself: a
// "Discovered" connector whose data appears nowhere.

type Row = Record<string, unknown> | null;
const tables: Record<string, Row> = {};

// A minimal chainable stand-in for the supabase query builder. Every terminal call resolves from `tables` by table name, so a test
// declares what each table holds and the builder shape does not have to be restated.
function builder(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: tables[table] ?? null, error: null });
  chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? null, error: null }).then(r);
  return chain;
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: (t: string) => builder(t) })) }));

import { getOktaConnectorStatus, findOwnOktaConnector } from "./okta-connector-status";

const CONFIG = {
  connector_id: "11111111-1111-4111-8111-111111111111",
  normalized_org_host: "trial-5294016.okta.com",
  client_id: "0oa15fcokefFqDREa698",
  approved_scopes: ["okta.users.read"],
  validation_status: "succeeded",
  validation_error_category: null,
  last_validated_at: "2026-07-30T23:01:30Z",
  certification_only: true,
  production_enabled: false,
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.okta_connector_configs = { ...CONFIG };
});

describe("getOktaConnectorStatus and supersession", () => {
  it("describes an ACTIVE connector normally", async () => {
    tables.connectors = { connection_state: "discovered", last_sync_at: null, superseded_by: null };
    const s = await getOktaConnectorStatus();
    expect(s).not.toBeNull();
    expect(s!.lifecycle).toBe("discovered");
  });

  it("reports NO connector when the one it resolves has been superseded", async () => {
    // Absent and superseded are deliberately the same answer. Anything else would show a "Discovered" connector whose people,
    // groups and applications are excluded from every other page.
    tables.connectors = { connection_state: "discovered", last_sync_at: null, superseded_by: "22222222-2222-4222-8222-222222222222" };
    expect(await getOktaConnectorStatus()).toBeNull();
  });

  it("does not leak the superseding connector's id", async () => {
    tables.connectors = { connection_state: "discovered", last_sync_at: null, superseded_by: "22222222-2222-4222-8222-222222222222" };
    expect(JSON.stringify(await getOktaConnectorStatus() ?? {})).not.toContain("22222222");
  });
});

describe("findOwnOktaConnector and supersession", () => {
  it("resolves a duplicate save against an active connector", async () => {
    tables.connectors = { superseded_by: null };
    expect(await findOwnOktaConnector("trial-5294016.okta.com", "0oa15fcokefFqDREa698")).toBe(CONFIG.connector_id);
  });

  it("refuses to point the customer at a superseded connector", async () => {
    // Its status page no longer resolves and its data is excluded everywhere; the generic duplicate message is the honest answer.
    tables.connectors = { superseded_by: "22222222-2222-4222-8222-222222222222" };
    expect(await findOwnOktaConnector("trial-5294016.okta.com", "0oa15fcokefFqDREa698")).toBeNull();
  });
});
