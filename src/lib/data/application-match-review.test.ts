import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// `accessGate` and `listDirectoryApplications` are deliberately REAL here. Mocking the gate would leave the editor/viewer
// denials proven against a stub — the exact vacuity that let a role widening pass green in #425 — so the only things faked are
// the two edges of the process: the request's tenant context and the database client.
const resolveTenantContext = vi.fn();
const createClient = vi.fn();
vi.mock("@/lib/auth/tenant-context", () => ({ resolveTenantContext: () => resolveTenantContext() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

import { decideApplicationMatch, loadApplicationMatchReview } from "./application-match-review";

const TENANT = "77777777-7777-7777-7777-777777777777";
const DA_1 = "d1111111-1111-1111-1111-111111111111";
const APP_A = "a1111111-1111-1111-1111-111111111111";
const APP_B = "a2222222-2222-2222-2222-222222222222";
const PROD = "p1111111-1111-1111-1111-111111111111";
const MATCH_1 = "m1111111-1111-1111-1111-111111111111";
const MATCH_2 = "m2222222-2222-2222-2222-222222222222";

type RpcCall = { name: string; args: Record<string, unknown> };
type TableQuery = { table: string; cols?: string; inCol?: string; inIds?: readonly string[]; op?: string };
type Reply = { data: unknown; error: unknown };

// Capturing client. Records every rpc name + argument set and every table query, so the assertions below can say what this
// module is ALLOWED to ask for — not merely what it did with an answer.
function makeSupabase(handlers: {
  rpc?: (name: string, args: Record<string, unknown>) => Reply;
  table?: (table: string, ids: readonly string[]) => Reply;
}) {
  const rpcCalls: RpcCall[] = [];
  const queries: TableQuery[] = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(handlers.rpc ? handlers.rpc(name, args) : { data: [], error: null });
    },
    from: (table: string) => {
      const q: TableQuery = { table };
      queries.push(q);
      const chain = {
        select: (cols: string) => { q.cols = cols; return chain; },
        in: (col: string, ids: readonly string[]) => {
          q.inCol = col;
          q.inIds = ids;
          return Promise.resolve(handlers.table ? handlers.table(table, ids) : { data: [], error: null });
        },
        insert: () => { q.op = "insert"; return Promise.resolve({ error: null }); },
        update: () => { q.op = "update"; return Promise.resolve({ error: null }); },
        upsert: () => { q.op = "upsert"; return Promise.resolve({ error: null }); },
        delete: () => { q.op = "delete"; return Promise.resolve({ error: null }); },
      };
      return chain;
    },
  };
  return { client, rpcCalls, queries };
}

const asRole = (role: string | null) =>
  resolveTenantContext.mockResolvedValue(role === null ? null : { activeTenant: { id: TENANT, role } });

// A complete, ordinary estate: one directory application recognised as one product, holding two operational records.
const MATCH_ROWS = [
  { id: MATCH_1, directory_application_id: DA_1, app_id: APP_A, status: "proposed" },
  { id: MATCH_2, directory_application_id: DA_1, app_id: APP_B, status: "proposed" },
];
const DIRECTORY_ROWS = [
  { id: DA_1, connection_id: "c1", provider: "okta", sync_status: "current", stale_since: null, label: "Salesforce", name: "salesforce", status_category: "active", sign_on_category: "saml", catalog_match_status: "unmatched" },
];
const CANDIDATE_ROWS = [
  { directory_application_id: DA_1, app_product_id: PROD, app_id: APP_A },
  { directory_application_id: DA_1, app_product_id: PROD, app_id: APP_B },
];
const APP_ROWS = [
  { id: APP_A, name: "Salesforce", instance_domain: "acme.my.salesforce.com", instance_url: null, external_instance_id: "00Dxx1" },
  { id: APP_B, name: "Salesforce", instance_domain: "acme--sandbox.my.salesforce.com", instance_url: null, external_instance_id: "00Dxx2" },
];
const PRODUCT_ROWS = [{ id: PROD, name: "Salesforce" }];

const happyPath = (over: { matches?: unknown[]; candidates?: unknown[]; directory?: unknown[]; apps?: unknown[]; products?: unknown[] } = {}) =>
  makeSupabase({
    rpc: (name) => {
      if (name === "product_application_matches") return { data: over.matches ?? MATCH_ROWS, error: null };
      if (name === "product_application_match_candidates") return { data: over.candidates ?? CANDIDATE_ROWS, error: null };
      if (name === "product_list_directory_applications") return { data: over.directory ?? DIRECTORY_ROWS, error: null };
      return { data: [], error: null };
    },
    table: (table) => {
      if (table === "apps") return { data: over.apps ?? APP_ROWS, error: null };
      if (table === "app_products") return { data: over.products ?? PRODUCT_ROWS, error: null };
      return { data: [], error: null };
    },
  });

beforeEach(() => {
  resolveTenantContext.mockReset();
  createClient.mockReset();
  asRole("owner");
});

// ══ B10 / B11 / B12 / M5 — who may see and decide ═══════════════════════════════════════════════════════════════════════════
describe("the owner/admin boundary", () => {
  it("B10 — an EDITOR is refused, and no read is attempted at all", async () => {
    asRole("editor");
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    expect(await loadApplicationMatchReview()).toEqual({ ok: false, error: "not_allowed" });
    expect(sb.rpcCalls).toEqual([]);
    expect(sb.queries).toEqual([]);
  });

  it("B11 — a VIEWER is refused the same way", async () => {
    asRole("viewer");
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    expect(await loadApplicationMatchReview()).toEqual({ ok: false, error: "not_allowed" });
    expect(sb.rpcCalls).toEqual([]);
  });

  it("an unauthenticated caller, and a member of no tenant, are refused identically", async () => {
    for (const ctx of [null, { activeTenant: null }]) {
      resolveTenantContext.mockResolvedValue(ctx);
      createClient.mockResolvedValue(happyPath().client);
      expect(await loadApplicationMatchReview()).toEqual({ ok: false, error: "not_allowed" });
    }
  });

  it("an editor cannot decide either — the same gate short-circuits the command", async () => {
    asRole("editor");
    const sb = makeSupabase({ rpc: () => { throw new Error("the decision command must not be reached"); } });
    createClient.mockResolvedValue(sb.client);
    expect(await decideApplicationMatch(MATCH_1, "accepted")).toEqual({ ok: false, error: "not_allowed" });
    expect(sb.rpcCalls).toEqual([]);
  });

  it("owner and admin both pass", async () => {
    for (const role of ["owner", "admin"]) {
      asRole(role);
      createClient.mockResolvedValue(happyPath().client);
      const r = await loadApplicationMatchReview();
      expect(r.ok, `${role} must be allowed`).toBe(true);
    }
  });

  it("B12 — the tenant is resolved server-side; no caller can supply or substitute one", async () => {
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    for (const c of sb.rpcCalls) expect(c.args.p_tenant_id).toBe(TENANT);
    // Neither entry point accepts a tenant argument, so a foreign tenant is not expressible from the product side.
    expect(loadApplicationMatchReview).toHaveLength(0);
    expect(decideApplicationMatch).toHaveLength(2);
  });
});

// ══ B1 / B2 / B3 — the queue ════════════════════════════════════════════════════════════════════════════════════════════════
describe("loading the queue", () => {
  it("B1 — nothing proposed: one read, an empty queue, and no label reads at all", async () => {
    const sb = happyPath({ matches: [] });
    createClient.mockResolvedValue(sb.client);
    expect(await loadApplicationMatchReview()).toEqual({ ok: true, data: { groups: [] } });
    expect(sb.rpcCalls.map((c) => c.name)).toEqual(["product_application_matches"]);
    expect(sb.queries).toEqual([]);
  });

  it("B2 — one proposal comes back fully labelled, with no uuid used as a name", async () => {
    const sb = happyPath({ matches: [MATCH_ROWS[0]], candidates: [CANDIDATE_ROWS[0]], apps: [APP_ROWS[0]] });
    createClient.mockResolvedValue(sb.client);
    const r = await loadApplicationMatchReview();
    if (!r.ok) throw new Error("expected a loaded queue");
    expect(r.data.groups).toHaveLength(1);
    expect(r.data.groups[0]).toMatchObject({ applicationLabel: "Salesforce", productLabel: "Salesforce", openCount: 1 });
    expect(r.data.groups[0].candidates[0]).toMatchObject({
      matchId: MATCH_1,
      appId: APP_A,
      recordLabel: "Salesforce",
      instanceLabel: "acme.my.salesforce.com",
      status: "proposed",
    });
  });

  it("B3 — two competing records for one application both arrive, neither preferred", async () => {
    createClient.mockResolvedValue(happyPath().client);
    const r = await loadApplicationMatchReview();
    if (!r.ok) throw new Error("expected a loaded queue");
    expect(r.data.groups).toHaveLength(1);
    expect(r.data.groups[0].candidates.map((c) => c.matchId).sort()).toEqual([MATCH_1, MATCH_2].sort());
    expect(r.data.groups[0].openCount).toBe(2);
  });

  it("a status outside the table's vocabulary is dropped, not rendered as an unknown state", async () => {
    const sb = happyPath({ matches: [{ ...MATCH_ROWS[0], status: "superseded" }, MATCH_ROWS[1]] });
    createClient.mockResolvedValue(sb.client);
    const r = await loadApplicationMatchReview();
    if (!r.ok) throw new Error("expected a loaded queue");
    expect(r.data.groups[0].candidates.map((c) => c.matchId)).toEqual([MATCH_2]);
  });

  it("keeps a settled match whose directory row is no longer listed, with a null label rather than an id", async () => {
    const sb = happyPath({ matches: [{ ...MATCH_ROWS[0], status: "accepted" }], directory: [], candidates: [] });
    createClient.mockResolvedValue(sb.client);
    const r = await loadApplicationMatchReview();
    if (!r.ok) throw new Error("expected a loaded queue");
    expect(r.data.groups).toHaveLength(1);
    expect(r.data.groups[0].applicationLabel).toBeNull();
    expect(r.data.groups[0].candidates[0].status).toBe("accepted");
  });

  it("asks the directory read for stale rows too, so a settled decision keeps its label", async () => {
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    const dir = sb.rpcCalls.find((c) => c.name === "product_list_directory_applications");
    expect(dir?.args.p_include_stale).toBe(true);
  });
});

// ══ the label reads ═════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("label reads stay inside their existing grants and columns", () => {
  it("reads the operational records by id, selecting only name and the instance discriminators", async () => {
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    const q = sb.queries.find((x) => x.table === "apps");
    expect(q?.cols).toBe("id, name, instance_domain, instance_url, external_instance_id");
    expect(q?.inCol).toBe("id");
    expect([...(q?.inIds ?? [])].sort()).toEqual([APP_A, APP_B].sort());
  });

  it("reads only the product name, and only for products the queue references", async () => {
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    const q = sb.queries.find((x) => x.table === "app_products");
    expect(q?.cols).toBe("id, name");
    expect(q?.inIds).toEqual([PROD]);
  });

  it("touches no table other than apps and app_products", async () => {
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    expect([...new Set(sb.queries.map((q) => q.table))].sort()).toEqual(["app_products", "apps"]);
  });

  it("prefers the domain, then the workspace address, then the provider's instance id", async () => {
    const cases = [
      [{ instance_domain: "d.example", instance_url: "https://u.example", external_instance_id: "X1" }, "d.example"],
      [{ instance_domain: null, instance_url: "https://u.example", external_instance_id: "X1" }, "https://u.example"],
      [{ instance_domain: null, instance_url: null, external_instance_id: "X1" }, "X1"],
      [{ instance_domain: "   ", instance_url: null, external_instance_id: null }, null],
    ] as const;
    for (const [fields, expected] of cases) {
      const sb = happyPath({ matches: [MATCH_ROWS[0]], apps: [{ id: APP_A, name: "Salesforce", ...fields }] });
      createClient.mockResolvedValue(sb.client);
      const r = await loadApplicationMatchReview();
      if (!r.ok) throw new Error("expected a loaded queue");
      expect(r.data.groups[0].candidates[0].instanceLabel).toBe(expected);
    }
  });
});

// ══ paging ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the match walk pages on its row-id cursor", () => {
  it("follows the cursor until a short page ends it", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      directory_application_id: DA_1,
      app_id: APP_A,
      status: "proposed",
    }));
    let page = 0;
    const sb = makeSupabase({
      rpc: (name) => {
        if (name === "product_application_matches") return { data: page++ === 0 ? full : [MATCH_ROWS[1]], error: null };
        if (name === "product_list_directory_applications") return { data: DIRECTORY_ROWS, error: null };
        if (name === "product_application_match_candidates") return { data: CANDIDATE_ROWS, error: null };
        return { data: [], error: null };
      },
      table: (t) => ({ data: t === "apps" ? APP_ROWS : PRODUCT_ROWS, error: null }),
    });
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    const walks = sb.rpcCalls.filter((c) => c.name === "product_application_matches");
    expect(walks).toHaveLength(2);
    expect(walks[0].args.p_after_id).toBeNull();
    expect(walks[1].args.p_after_id).toBe("m0499");
  });
});

// THE SUBTLETY OF THE 0090 FEED. Its page is bounded at 200 PARENT directory applications and each parent then expands to its
// COMPLETE instance set, so row count says nothing about whether the feed is exhausted. A walk that used it would fetch a
// second page for any estate whose first page exploded past the limit — and would stop early on one whose parents each own a
// single instance. Termination is on DISTINCT PARENTS, and these two tests are the difference.
describe("the candidate walk pages on PARENTS, never on rows", () => {
  const parentPage = (offset: number, parents: number, perParent: number) =>
    Array.from({ length: parents }, (_, p) =>
      Array.from({ length: perParent }, (_, i) => ({
        directory_application_id: `da-${String(offset + p).padStart(4, "0")}`,
        app_product_id: PROD,
        app_id: `app-${p}-${i}`,
      })),
    ).flat();

  const walkWith = async (pages: unknown[][]) => {
    let n = 0;
    const sb = makeSupabase({
      rpc: (name) => {
        if (name === "product_application_matches") return { data: MATCH_ROWS, error: null };
        if (name === "product_list_directory_applications") return { data: DIRECTORY_ROWS, error: null };
        if (name === "product_application_match_candidates") return { data: pages[Math.min(n++, pages.length - 1)], error: null };
        return { data: [], error: null };
      },
      table: (t) => ({ data: t === "apps" ? APP_ROWS : PRODUCT_ROWS, error: null }),
    });
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    return sb.rpcCalls.filter((c) => c.name === "product_application_match_candidates");
  };

  it("STOPS after a page of 600 rows that holds only 2 parents (row count would have kept walking)", async () => {
    const calls = await walkWith([parentPage(0, 2, 300)]);
    expect(calls).toHaveLength(1);
  });

  it("CONTINUES after a page of exactly 200 parents, then stops on the short one", async () => {
    const calls = await walkWith([parentPage(0, 200, 1), parentPage(200, 5, 1)]);
    expect(calls).toHaveLength(2);
    expect(calls[0].args.p_after_directory_application_id).toBeNull();
    expect(calls[1].args.p_after_directory_application_id).toBe("da-0199");
  });

  it("stops on an empty page rather than walking forever", async () => {
    const calls = await walkWith([[]]);
    expect(calls).toHaveLength(1);
  });
});

// ══ B5 / B6 / B7 / B8 / B9 / M6 / M8 — the decision ═════════════════════════════════════════════════════════════════════════
describe("deciding one candidate", () => {
  const decideWith = (reply: Reply) => {
    const sb = makeSupabase({ rpc: () => reply });
    createClient.mockResolvedValue(sb.client);
    return sb;
  };

  it("B5 — accept calls the governed command with the server tenant, the match id and 'accepted'", async () => {
    const sb = decideWith({ data: { status: "accepted" }, error: null });
    expect(await decideApplicationMatch(MATCH_1, "accepted")).toEqual({ ok: true, status: "accepted" });
    expect(sb.rpcCalls).toHaveLength(1);
    expect(sb.rpcCalls[0].name).toBe("product_decide_application_match");
    expect(sb.rpcCalls[0].args).toEqual({ p_tenant_id: TENANT, p_match_id: MATCH_1, p_decision: "accepted" });
    // No who/when parameter exists to pass — the command takes both from the session and the database clock.
    expect(Object.keys(sb.rpcCalls[0].args)).toHaveLength(3);
  });

  it("B6 — reject calls the SAME command, differing only in the decision", async () => {
    const sb = decideWith({ data: { status: "rejected" }, error: null });
    expect(await decideApplicationMatch(MATCH_1, "rejected")).toEqual({ ok: true, status: "rejected" });
    expect(sb.rpcCalls[0].name).toBe("product_decide_application_match");
    expect(sb.rpcCalls[0].args.p_decision).toBe("rejected");
  });

  it("B13 — a decision never writes a table directly", async () => {
    const sb = decideWith({ data: { status: "accepted" }, error: null });
    await decideApplicationMatch(MATCH_1, "accepted");
    expect(sb.queries).toEqual([]);
  });

  // B7 / B8 / M6 — a replayed decision is reported truthfully, and is NOT a failure.
  it("B7 / B8 — every settled and raced result is passed through as a success", async () => {
    for (const status of ["already_decided", "already_accepted", "already_rejected", "already_proposed", "accepted_exists"]) {
      decideWith({ data: { status }, error: null });
      expect(await decideApplicationMatch(MATCH_1, "accepted")).toEqual({ ok: true, status });
    }
  });

  it("B9 — the loser of a concurrent acceptance gets accepted_exists, not an error", async () => {
    decideWith({ data: { status: "accepted_exists" }, error: null });
    const r = await decideApplicationMatch(MATCH_2, "accepted");
    expect(r).toEqual({ ok: true, status: "accepted_exists" });
  });

  it("a refusal is reported as itself, not as an outage", async () => {
    for (const status of ["not_allowed", "invalid_decision"]) {
      decideWith({ data: { status }, error: null });
      expect(await decideApplicationMatch(MATCH_1, "accepted")).toEqual({ ok: true, status });
    }
  });

  it("an unrecognised status is a failure rather than something rendered", async () => {
    decideWith({ data: { status: "definitely_not_a_status" }, error: null });
    expect(await decideApplicationMatch(MATCH_1, "accepted")).toEqual({ ok: false, error: "query_failed" });
  });

  it("M8 — a database error becomes a bounded label carrying no query detail", async () => {
    decideWith({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "application_matches_one_accepted_dir_idx"' } });
    const r = await decideApplicationMatch(MATCH_1, "accepted");
    expect(r).toEqual({ ok: false, error: "query_failed" });
    expect(JSON.stringify(r)).not.toMatch(/duplicate key|constraint|23505|application_matches/);
  });

  it("surfaces ONLY the status — an extra field added to the reply can never reach a caller", async () => {
    decideWith({ data: { status: "accepted", decided_by: "u-1", external_id: "0oaLEAK" }, error: null });
    const r = await decideApplicationMatch(MATCH_1, "accepted");
    expect(r).toEqual({ ok: true, status: "accepted" });
    expect(JSON.stringify(r)).not.toMatch(/0oaLEAK|decided_by/);
  });

  it("a failed read is never reported as an empty queue", async () => {
    const sb = makeSupabase({ rpc: () => ({ data: null, error: { message: "connection reset" } }) });
    createClient.mockResolvedValue(sb.client);
    const r = await loadApplicationMatchReview();
    expect(r).toEqual({ ok: false, error: "query_failed" });
    expect(JSON.stringify(r)).not.toContain("connection reset");
  });

  it("a failed label read fails the load rather than rendering blank labels", async () => {
    for (const broken of ["apps", "app_products", "product_list_directory_applications", "product_application_match_candidates"]) {
      const sb = makeSupabase({
        rpc: (name) => {
          if (name === broken) return { data: null, error: { message: "boom" } };
          if (name === "product_application_matches") return { data: MATCH_ROWS, error: null };
          if (name === "product_list_directory_applications") return { data: DIRECTORY_ROWS, error: null };
          if (name === "product_application_match_candidates") return { data: CANDIDATE_ROWS, error: null };
          return { data: [], error: null };
        },
        table: (t) => (t === broken ? { data: null, error: { message: "boom" } } : { data: t === "apps" ? APP_ROWS : PRODUCT_ROWS, error: null }),
      });
      createClient.mockResolvedValue(sb.client);
      expect(await loadApplicationMatchReview(), `a failed ${broken} read must fail the load`).toEqual({ ok: false, error: "query_failed" });
    }
  });
});

// ══ B14 / M2 — nothing decides on the customer's behalf ═════════════════════════════════════════════════════════════════════
describe("B14 — loading the queue decides nothing", () => {
  // Every cardinality, because a lone candidate is the one an "obviously it must be this" shortcut would take. A mutant that
  // decided it while merely loading the page survived a version of this suite that only checked the RETURNED status: the write
  // had already happened, and the view model was assembled before it. So the assertion is on the CALLS, for every shape.
  const SHAPES = {
    "one candidate": { matches: [MATCH_ROWS[0]], candidates: [CANDIDATE_ROWS[0]], apps: [APP_ROWS[0]] },
    "two candidates": {},
    "one already accepted": { matches: [{ ...MATCH_ROWS[0], status: "accepted" }] },
  };

  for (const [shape, over] of Object.entries(SHAPES)) {
    it(`never calls the decision command, and never proposes — ${shape}`, async () => {
      const sb = happyPath(over);
      createClient.mockResolvedValue(sb.client);
      await loadApplicationMatchReview();
      const names = sb.rpcCalls.map((c) => c.name);
      expect(names).not.toContain("product_decide_application_match");
      expect(names).not.toContain("product_propose_application_match");
      // the read path calls reads only
      expect(names.every((n) => n.startsWith("product_application_match") || n === "product_list_directory_applications")).toBe(true);
    });
  }

  it("a lone candidate is still proposed after a load — cardinality is not consent", async () => {
    const sb = happyPath({ matches: [MATCH_ROWS[0]], candidates: [CANDIDATE_ROWS[0]], apps: [APP_ROWS[0]] });
    createClient.mockResolvedValue(sb.client);
    const r = await loadApplicationMatchReview();
    if (!r.ok) throw new Error("expected a loaded queue");
    expect(r.data.groups[0].candidates[0].status).toBe("proposed");
    expect(r.data.groups[0].openCount).toBe(1);
    expect(sb.rpcCalls.map((c) => c.name)).not.toContain("product_decide_application_match");
  });

  it("never starts, completes or fails a matcher run — execution state and human decisions are separate facts", async () => {
    const sb = happyPath();
    createClient.mockResolvedValue(sb.client);
    await loadApplicationMatchReview();
    for (const c of sb.rpcCalls) expect(c.name).not.toMatch(/matcher_run|application_matcher_state/);
  });
});

// ══ Source contracts (tripwires, not behaviour) ═════════════════════════════════════════════════════════════════════════════
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const LANE_SOURCES = [
  "src/lib/canonical/application-match-review.ts",
  "src/lib/data/application-match-review.ts",
  "src/app/(authenticated)/directory/applications/review/page.tsx",
  "src/app/(authenticated)/directory/applications/review/actions.ts",
];
// Every file this lane adds or edits, tests included. The behavioural tripwires above only care about runtime source,
// but the grep-visibility one below applies to all of them: the safety gates scan the whole of src/, so a test file can
// blind them just as effectively as a runtime file can.
const LANE_FILES = [
  ...LANE_SOURCES,
  "src/lib/canonical/application-match-review.test.ts",
  "src/lib/data/application-match-review.test.ts",
  "src/app/(authenticated)/directory/applications/review/actions.test.ts",
  "src/app/(authenticated)/directory/applications/review/review.ui.test.tsx",
  "src/app/(authenticated)/directory/applications/page.tsx",
];
const stripComments = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("B13 / M4 — no file in this lane can write a table", () => {
  it("contains no insert, update, upsert or delete anywhere", async () => {
    for (const p of LANE_SOURCES) {
      const code = stripComments(read(p));
      for (const w of [".insert(", ".update(", ".upsert(", ".delete("]) {
        expect(code, `${p} must not contain ${w}`).not.toContain(w);
      }
    }
  });

  it("never names application_matches as a table", () => {
    for (const p of LANE_SOURCES) expect(stripComments(read(p))).not.toMatch(/from\(["']application_matches["']\)/);
  });

  it("reads no deny-all directory table directly", () => {
    for (const p of LANE_SOURCES) expect(stripComments(read(p))).not.toMatch(/from\(["']directory_/);
  });

  it("reaches the database only through the user-scoped server client", () => {
    for (const p of LANE_SOURCES) {
      for (const line of read(p).split("\n").filter((l) => l.startsWith("import") && /supabase/i.test(l))) {
        expect(line).toContain('from "@/lib/supabase/server"');
      }
    }
  });

  it("adds no provider-specific branching — provider strings stay opaque", () => {
    for (const p of LANE_SOURCES) {
      expect(stripComments(read(p))).not.toMatch(/["'](okta|slack|google|entra|microsoft|github)["']/i);
    }
  });

  // ── the file must stay TEXT, or the safety gates stop seeing it ─────────────────────────────────────────────────────
  // This is not style. `scripts/check-auth-safety.sh` and `scripts/check-app-runtime-imports.sh` both scan with
  // `grep -I`, which SKIPS any file grep classifies as binary — and one raw NUL byte anywhere is enough to earn that
  // classification. A source file containing one is therefore silently exempt from the credential scan and the
  // app-to-runner import boundary, and it passes both gates no matter what it contains. That is how this lane shipped a
  // review-blocking hole: the composite key in the pure module used a NUL separator written as the raw byte.
  //
  // The separator is still U+0000 at runtime, and must stay so (a separator that can occur inside a label makes
  // distinguishable records collide — proven in canonical/application-match-review.test.ts). Only the SPELLING changed:
  // the escape sequence, never the byte. `git diff` will not catch this for you — git only samples the first 8000 bytes
  // for its own binary heuristic, so a NUL past that point diffs as ordinary text while grep still refuses the file.
  it("no file in this lane contains a raw NUL byte, so the grep-based safety gates can still read it", () => {
    const NUL = String.fromCharCode(0);
    for (const p of LANE_FILES) {
      const raw = fs.readFileSync(path.join(process.cwd(), p), "utf8");
      expect(raw.includes(NUL), `${p} contains a raw NUL byte and would be skipped by grep -I`).toBe(false);
    }
  });
});

describe("scope — the matcher and the migrations are untouched by this lane", () => {
  it("no file in this lane runs, schedules or re-runs the matcher", () => {
    for (const p of LANE_SOURCES) {
      const code = read(p);
      for (const f of ["runApplicationMatcher", "runTenantApplicationMatcher", "createMatcherIo", "product_start_application_matcher_run"]) {
        expect(code, `${p} must not reference ${f}`).not.toContain(f);
      }
    }
  });

  // Every database function this lane names, read straight off the source as a string literal. Two reads and ONE writer, and
  // the writer is the governed decision command. The directory-application read is absent on purpose: it is reached through
  // the existing access repository rather than named again here.
  it("the only writer this lane invokes is the governed decision command", () => {
    const commands = LANE_SOURCES.flatMap((p) =>
      [...stripComments(read(p)).matchAll(/["'](product_[a-z_]+)["']/g)].map((m) => m[1]),
    );
    expect([...new Set(commands)].sort()).toEqual([
      "product_application_match_candidates",
      "product_application_matches",
      "product_decide_application_match",
    ]);
  });

  // THIS LANE OWNS NO MIGRATION — and that is a property of ITS OWN FILES, never of the repository's migration numbering.
  //
  // An earlier version of this test asserted "no migration numbered above 0091 exists anywhere in the repository". That is
  // a claim about every OTHER lane's future work: the next unrelated migration, from any concurrent branch, would have
  // turned this test red on `main` and named this file as the failure — for a change it has nothing to do with. A lane may
  // only assert what it owns.
  //
  // Changed-file scope is already covered, twice, by machinery that is actually authorized to judge it:
  // `scripts/check-migration-safety.sh` and `git diff origin/main..HEAD -- supabase/migrations` in the PR gates. What
  // belongs HERE is the complementary half those cannot see: that nothing in this lane's own source carries schema
  // behaviour, so it could not need a migration in the first place.
  it("no file in this lane carries schema or migration behaviour", () => {
    for (const p of LANE_SOURCES) {
      const code = stripComments(read(p));
      for (const ddl of [
        /create\s+(or\s+replace\s+)?function/i,
        /create\s+table/i,
        /alter\s+table/i,
        /create\s+policy/i,
        /create\s+(unique\s+)?index/i,
        /\bgrant\s+execute/i,
        /\brevoke\s+/i,
        /drop\s+(table|function|constraint|policy)/i,
        /security\s+definer/i,
      ]) {
        expect(code, `${p} must carry no schema statement (${ddl})`).not.toMatch(ddl);
      }
      expect(code, `${p} must not reach into the migration directory`).not.toContain("supabase/migrations");
    }
  });

  // ── the page size this loader ASKS for must equal the cap the function ENFORCES ──────────────────────────────────────
  // Both walkers decide "was that the last page?" by comparing what came back against the size they requested. Each
  // function silently clamps its own limit — `least(coalesce(p_limit, N), N)` — so if a constant here ever exceeds N, the
  // request is trimmed, the comparison can never be satisfied, and the walk stops after ONE page while believing it
  // finished. That is silent truncation of a governance feed: matches simply missing from the queue, with nothing to
  // show anything went wrong. Nothing else in the repository ties these two numbers together, so this is the only place
  // raising one without the other fails.
  const capOf = (sql: string, fn: string): number => {
    const start = sql.indexOf(`create or replace function public.${fn}(`);
    expect(start, `${fn} must exist in the migration`).toBeGreaterThanOrEqual(0);
    const body = sql.slice(start, sql.indexOf("$$;", start));
    const m = body.match(/least\(coalesce\(p_limit,\s*(\d+)\),\s*(\d+)\)/);
    expect(m, `${fn} must clamp its own limit`).not.toBeNull();
    // the default and the ceiling are the same number in every one of these reads; if they ever diverge, the ceiling wins
    return Number.parseInt(m![2], 10);
  };
  const constOf = (name: string): number => {
    const m = read("src/lib/data/application-match-review.ts").match(new RegExp(`const ${name} = (\\d+);`));
    expect(m, `${name} must be declared`).not.toBeNull();
    return Number.parseInt(m![1], 10);
  };

  it("MATCH_PAGE equals the ceiling product_application_matches enforces", () => {
    const cap = capOf(read("supabase/migrations/0085_governance_canonical_read_boundary.sql"), "product_application_matches");
    expect(cap).toBe(500);
    expect(constOf("MATCH_PAGE")).toBe(cap);
  });

  it("CANDIDATE_PARENT_PAGE equals the PARENT ceiling product_application_match_candidates enforces", () => {
    const cap = capOf(read("supabase/migrations/0090_application_match_candidate_contract.sql"), "product_application_match_candidates");
    expect(cap).toBe(200);
    expect(constOf("CANDIDATE_PARENT_PAGE")).toBe(cap);
  });

  it("DIRECTORY_PAGE is within the ceiling the access repository clamps every list read to", () => {
    // That read goes through `listDirectoryApplications`, whose `clampLimit` trims to MAX_PAGE before the call, so the
    // effective bound is the repository's, not a migration's.
    const m = read("src/lib/data/access-repository.ts").match(/export const MAX_PAGE = (\d+);/);
    expect(m).not.toBeNull();
    expect(constOf("DIRECTORY_PAGE")).toBe(Number.parseInt(m![1], 10));
  });
});

// ── Anti-vacuity ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Nothing in this file proves the DATABASE refuses an editor, a foreign tenant or a second acceptance — a mock cannot. Those
// rest on the 0088 suite running against a real database. Pin the exact assertions this surface depends on, so deleting them
// cannot silently strip this lane of its only real authorization and concurrency proof.
describe("the real-database proofs this surface stands on", () => {
  const sql = read("supabase/tests/application_match_review_boundary_test.sql");

  it("proves editor and viewer cannot decide", () => {
    expect(sql).toContain("B7 viewer must not decide");
    expect(sql).toContain("B7 editor must not decide");
    expect(sql).toContain("B7 a refused decision leaves the candidate untouched");
  });

  it("proves a foreign tenant cannot decide, and that naming the owning tenant does not help", () => {
    expect(sql).toContain("B6 a foreign tenant must not decide this match");
    expect(sql).toContain("B6 naming the OWNING tenant does not help a non-member either");
  });

  it("proves the concurrency outcome this surface reports: one accepted, the loser still a proposal", () => {
    expect(sql).toContain("B8 a second accepted match for one directory application must be refused");
    expect(sql).toContain("B8 exactly one accepted match may exist per directory application");
    expect(sql).toContain("B8 the losing candidate stays proposed");
  });

  it("proves a decided row cannot be flipped, and that replay resurrects nothing", () => {
    expect(sql).toContain("B9 an accepted match cannot be flipped");
    expect(sql).toContain("B9 a rejected match cannot be flipped");
    expect(sql).toContain("B10 re-proposing a REJECTED candidate must report it, not resurrect it");
  });

  it("proves the table stays unreachable from a browser role, so the command is the only writer", () => {
    expect(sql).toContain("B0 authenticated must NOT hold UPDATE");
    expect(sql).toContain("B0 application_matches must still have NO policy");
  });

  it("every file this lane adds is inside the tree the credential scanner covers", () => {
    expect(read("scripts/check-auth-safety.sh")).toMatch(/scan_dir "\$REPO\/src"/);
    for (const p of LANE_SOURCES) expect(p.startsWith("src/")).toBe(true);
  });
});
