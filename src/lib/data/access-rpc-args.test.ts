import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression for the /access load failure (PR I): the repository must pass ONLY arguments that the migration-0061 function DECLARES.
// Passing an undeclared arg (getAccessCounts sent `p_include_stale`, which product_directory_access_counts does not declare) makes PostgREST
// return PGRST202 "could not find the function … in the schema cache" → the loader's query_failed → the browser's "Access data could not be
// loaded." The prior loader/repository tests mocked the client and never checked the real arg set against the real signatures — this does.
const calls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve({ data: null, error: null }); },
  })),
}));

import * as repo from "./access-repository";

// Extract each 0061 function's declared params + whether each has a DEFAULT (multi-line signature up to `) returns`; params have no nested
// commas, so a comma-split is safe). Both directions matter: an UNDECLARED arg AND a dropped REQUIRED (no-default) arg each yield PGRST202.
const MIGRATION = readFileSync(join(__dirname, "../../../supabase/migrations/0061_canonical_directory_product_read_rpcs.sql"), "utf8");
function paramSpecs(fnName: string): { name: string; required: boolean }[] {
  const m = MIGRATION.match(new RegExp(`create or replace function public\\.${fnName}\\(([\\s\\S]*?)\\)\\s+returns`, "i"));
  if (!m) throw new Error(`0061 function ${fnName} not found`);
  return m[1].split(",").map((seg) => {
    const name = seg.match(/\b(p_[a-z_]+)\b/)?.[1];
    return name ? { name, required: !/\bdefault\b/.test(seg) } : null;
  }).filter((x): x is { name: string; required: boolean } => x !== null);
}
const declaredParams = (fn: string) => paramSpecs(fn).map((p) => p.name);
const requiredParams = (fn: string) => paramSpecs(fn).filter((p) => p.required).map((p) => p.name);

const TID = "11111111-2222-4333-8444-555555555555";
beforeEach(() => { calls.length = 0; });

describe("access-repository RPC args ⊆ migration-0061 declared params (schema-cache / PGRST202 safety)", () => {
  it("no accessor passes an argument the 0061 function does not declare", async () => {
    await repo.getAccessCounts(TID);
    await repo.listDirectoryIdentities(TID);
    await repo.listDirectoryGroups(TID);
    await repo.listDirectoryApplications(TID);
    await repo.listGroupMemberships(TID);
    await repo.listUserAssignments(TID);
    await repo.listGroupAssignments(TID);
    await repo.getIdentityAccessSubgraph(TID, TID);
    await repo.getApplicationAccessSubgraph(TID, TID);
    expect(calls).toHaveLength(9);
    for (const { name, args } of calls) {
      const declared = declaredParams(name);
      const keys = Object.keys(args);
      // (a) no UNDECLARED arg (the p_include_stale-on-counts bug), and (b) every REQUIRED (no-default) param is present (a dropped
      //     p_tenant_id / p_identity_id / p_application_id yields the SAME PGRST202). Both directions of the arg-mismatch class are covered.
      for (const key of keys) {
        expect(declared, `${name} passed undeclared arg "${key}" (declared: ${declared.join(", ")})`).toContain(key);
      }
      for (const req of requiredParams(name)) {
        expect(keys, `${name} is missing required arg "${req}" (required: ${requiredParams(name).join(", ")})`).toContain(req);
      }
    }
  });

  it("getAccessCounts passes exactly { p_tenant_id } — the counts function is stale-agnostic (no p_include_stale)", async () => {
    await repo.getAccessCounts(TID);
    expect(calls).toEqual([{ name: "product_directory_access_counts", args: { p_tenant_id: TID } }]);
    expect(declaredParams("product_directory_access_counts")).not.toContain("p_include_stale");
  });
});
