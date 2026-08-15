import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate, listDirectoryApplications } from "./access-repository";
import { parseRows } from "./access-rpc-types";
import { applicationLabel } from "./access-view-models";
import {
  buildReviewGroups,
  isDecideStatus,
  isMatchStatus,
  type AppLabel,
  type DecideStatus,
  type Decision,
  type MatchRow,
  type ReviewGroupView,
} from "@/lib/canonical/application-match-review";

// Phase 18F-B — the IO half of application-match review. Pure rules (ordering, grouping, the decide-status vocabulary) live in
// src/lib/canonical/application-match-review.ts; this module only talks to the database.
//
// THIS MODULE NEVER WRITES A TABLE. The single mutation is the 0088 `product_decide_application_match` command, and it is the
// only writer that exists: `application_matches` is RLS-on-with-no-policy and revoked from `authenticated` (0075), so a direct
// insert/update/upsert from here could not execute even if somebody wrote one. The command sets `decided_by` from `auth.uid()`
// and `decided_at` from the database clock, so this module cannot attribute or backdate a decision.
//
// WHY FIVE READS. The two match reads return ids and nothing else by design, so a usable screen has to fetch its labels
// separately from the sources authorized to give them:
//
//   product_application_matches                 (0085)  the proposals themselves — id, directory application, app, status
//   product_list_directory_applications         (0061/0073)  the ONLY source of a directory application's name; that table is
//                                                       deny-all to every browser role, so there is no other way to get it
//   product_application_match_candidates        (0090)  directory application → its confirmed canonical product. Used for the
//                                                       PRODUCT LABEL ONLY — see the note on its candidate rows below
//   apps                                        (0001 "members read apps")  the operational record's own name + instance
//   app_products                                (0024 "members read app_products")  the canonical product's name
//
// The last two are plain RLS-governed reads through the user-scoped client — the same reads /apps and the canonicalization
// helpers already perform. No grant is widened anywhere: the owner/admin boundary is `accessGate()` plus each command's own
// `has_tenant_role`, and the two table reads sit inside grants that already existed.
//
// A NOTE ON WHAT 0090's ROWS ARE NOT USED FOR. That read also enumerates every operational instance of the resolved product,
// including instances with no proposal. Those are the MATCHER's candidates, not this surface's: deciding requires a match id,
// and a row with no proposal has none. Rendering them would put "candidates" on screen that nobody proposed and nothing can
// accept. Only the (directory application → product) column is consumed here.

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
};

// ── runtime validation of the two match RPCs ─────────────────────────────────────────────────────────────────────────────────
// Neither function appears in the generated database types, so the .rpc boundary is narrow-cast and every row is parsed before
// it reaches the pure layer. zod strips unknown keys, so a future column added to either read cannot arrive here by accident.
const uuid = z.string().min(1);
const matchRowSchema = z.object({
  id: uuid,
  directory_application_id: uuid,
  app_id: uuid,
  status: z.string().min(1),
});
const candidateRowSchema = z.object({
  directory_application_id: uuid,
  app_product_id: uuid,
  // NULL is the 0090 zero-instance contract: product resolved, no operational record exists. Not read here (see above), but
  // declared so the row still validates instead of being dropped — dropping it would lose the parent's product mapping.
  app_id: uuid.nullable().optional().transform((v) => v ?? null),
});

type RpcFn = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
const rpcOf = (supabase: Awaited<ReturnType<typeof createClient>>): RpcFn =>
  supabase.rpc.bind(supabase) as unknown as RpcFn;

// 0085 pages at 500, 0090 pages at 200 PARENTS, the 0061 list reads page at 100. The guard is a backstop against a
// non-advancing cursor, never the bound — each read's own cap is.
const MATCH_PAGE = 500;
const CANDIDATE_PARENT_PAGE = 200;
const DIRECTORY_PAGE = 100;
const PAGE_GUARD = 1000;

const ID_CHUNK = 100;
function chunk(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push([...ids.slice(i, i + ID_CHUNK)]);
  return out;
}

export type ApplicationMatchReviewData = {
  readonly groups: readonly ReviewGroupView[];
};
export type ApplicationMatchReviewResult =
  | { readonly ok: true; readonly data: ApplicationMatchReviewData }
  | { readonly ok: false; readonly error: "not_allowed" | "query_failed" };

// ── the proposals ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Walks the 0085 read on its `id` cursor. A row whose status is outside the 0075 vocabulary is DROPPED rather than rendered as
// an unknown state — the alternative is a candidate on screen with controls whose effect nobody can predict.
async function readMatches(rpc: RpcFn, tenantId: string): Promise<MatchRow[] | null> {
  const rows: MatchRow[] = [];
  let afterId: string | null = null;
  for (let guard = 0; guard < PAGE_GUARD; guard++) {
    const { data, error } = await rpc("product_application_matches", {
      p_tenant_id: tenantId,
      p_after_id: afterId,
      p_limit: MATCH_PAGE,
    });
    if (error) {
      console.error("[data/application-match-review] match read failed");
      return null;
    }
    const page = parseRows(matchRowSchema, data);
    for (const r of page) {
      if (isMatchStatus(r.status)) {
        rows.push({ matchId: r.id, directoryApplicationId: r.directory_application_id, appId: r.app_id, status: r.status });
      }
    }
    if (page.length < MATCH_PAGE) return rows;
    afterId = page[page.length - 1].id;
  }
  return rows;
}

// ── the upstream product recognition ─────────────────────────────────────────────────────────────────────────────────────────
// TERMINATION IS ON DISTINCT PARENTS, NOT ROW COUNT, and that is the whole subtlety of this read. 0090 bounds the page at 200
// PARENT directory applications and then expands each to its COMPLETE instance set, so a page of 200 parents can be any number
// of rows — using row count as the "last page" signal would stop the walk early on a many-instance estate, or loop forever on
// one. Parents per page can never exceed the limit, and the LEFT JOIN guarantees every parent yields at least one row, so
// "fewer distinct parents than the limit" is the exact end-of-feed condition.
async function readProductOf(rpc: RpcFn, tenantId: string): Promise<Map<string, string> | null> {
  const productOf = new Map<string, string>();
  let afterParent: string | null = null;
  for (let guard = 0; guard < PAGE_GUARD; guard++) {
    const { data, error } = await rpc("product_application_match_candidates", {
      p_tenant_id: tenantId,
      p_after_directory_application_id: afterParent,
      p_limit: CANDIDATE_PARENT_PAGE,
    });
    if (error) {
      console.error("[data/application-match-review] candidate read failed");
      return null;
    }
    const page = parseRows(candidateRowSchema, data);
    if (page.length === 0) return productOf;
    const parents = new Set<string>();
    for (const r of page) {
      parents.add(r.directory_application_id);
      productOf.set(r.directory_application_id, r.app_product_id);
    }
    if (parents.size < CANDIDATE_PARENT_PAGE) return productOf;
    // The feed is ordered by parent id, so the last row carries the highest parent on the page.
    afterParent = page[page.length - 1].directory_application_id;
  }
  return productOf;
}

// ── the directory application names ──────────────────────────────────────────────────────────────────────────────────────────
// `includeStale: true` on purpose. A canonical decision outlives the freshness of the row it was made about — docs/79 keeps
// provider freshness and canonical judgement as separate facts — so excluding stale rows would blank the label on exactly the
// settled matches Phase 6 requires to render. A row still absent (superseded or disconnected connector) simply has no label,
// which the surface says rather than substituting an id.
async function readApplicationLabels(tenantId: string): Promise<Map<string, string> | null> {
  const labels = new Map<string, string>();
  let afterId: string | null = null;
  for (let guard = 0; guard < PAGE_GUARD; guard++) {
    const r = await listDirectoryApplications(tenantId, { afterId, includeStale: true, limit: DIRECTORY_PAGE });
    if (!r.ok) return null;
    for (const row of r.data) labels.set(row.id, applicationLabel(row));
    if (r.data.length < DIRECTORY_PAGE) return labels;
    afterId = r.data[r.data.length - 1].id;
  }
  return labels;
}

// ── the operational record labels ────────────────────────────────────────────────────────────────────────────────────────────
// `instanceLabel` is the discriminator that makes two records of the SAME product answerable: domain first (the most human of
// the three), then the workspace URL, then the provider's own instance id. All three are non-secret instance identity — the
// same fields /apps/[id] already shows — and none of them is a credential.
async function readAppLabels(
  supabase: Awaited<ReturnType<typeof createClient>>,
  appIds: readonly string[],
): Promise<Map<string, AppLabel> | null> {
  const labels = new Map<string, AppLabel>();
  for (const ids of chunk(appIds)) {
    const { data, error } = await supabase
      .from("apps")
      .select("id, name, instance_domain, instance_url, external_instance_id")
      .in("id", ids);
    if (error) {
      console.error("[data/application-match-review] operational record read failed");
      return null;
    }
    for (const r of data ?? []) {
      labels.set(r.id, {
        recordLabel: clean(r.name),
        instanceLabel: clean(r.instance_domain) ?? clean(r.instance_url) ?? clean(r.external_instance_id),
      });
    }
  }
  return labels;
}

async function readProductNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productIds: readonly string[],
): Promise<Map<string, string> | null> {
  const names = new Map<string, string>();
  for (const ids of chunk(productIds)) {
    const { data, error } = await supabase.from("app_products").select("id, name").in("id", ids);
    if (error) {
      console.error("[data/application-match-review] product read failed");
      return null;
    }
    for (const r of data ?? []) {
      const n = clean(r.name);
      if (n !== null) names.set(r.id, n);
    }
  }
  return names;
}

/**
 * Load the application-match review queue for the signed-in owner/admin.
 *
 * `not_allowed` is returned for anyone below owner/admin BEFORE any read runs. That distinction is load-bearing: the 0085 read
 * returns ZERO ROWS to an editor or viewer rather than an error, so a surface that rendered whatever came back would tell them
 * "nothing to review" — a false statement about a queue they simply may not see. The gate is what keeps the empty state
 * honest, and it is the same owner/admin boundary the commands re-verify server-side.
 */
export async function loadApplicationMatchReview(): Promise<ApplicationMatchReviewResult> {
  const gate = await accessGate();
  if (!gate.ok) return { ok: false, error: "not_allowed" };

  const supabase = await createClient();
  const matches = await readMatches(rpcOf(supabase), gate.tenantId);
  if (matches === null) return { ok: false, error: "query_failed" };
  // Nothing proposed: the four label reads would all be empty joins. An empty queue is a real answer, reached with one read.
  if (matches.length === 0) return { ok: true, data: { groups: [] } };

  const appIds = [...new Set(matches.map((m) => m.appId))];
  const [application, productOf, app] = await Promise.all([
    readApplicationLabels(gate.tenantId),
    readProductOf(rpcOf(supabase), gate.tenantId),
    readAppLabels(supabase, appIds),
  ]);
  if (application === null || productOf === null || app === null) return { ok: false, error: "query_failed" };

  // Only the products the queue actually references.
  const referenced = [...new Set(matches.map((m) => productOf.get(m.directoryApplicationId)).filter((p): p is string => p !== undefined))];
  const productName = await readProductNames(supabase, referenced);
  if (productName === null) return { ok: false, error: "query_failed" };

  return { ok: true, data: { groups: buildReviewGroups(matches, { application, productOf, productName, app }) } };
}

export type DecideResult =
  | { readonly ok: true; readonly status: DecideStatus }
  | { readonly ok: false; readonly error: "not_allowed" | "query_failed" };

/**
 * Accept or reject ONE proposed candidate through the 0088 command.
 *
 * Authorization is the command's: it re-verifies owner/admin via `has_tenant_role` against `auth.uid()`. `accessGate()` here
 * resolves the tenant from trusted server context and short-circuits anyone below owner/admin — it narrows, it does not
 * authorize, and the tenant id it passes is verified on the other side rather than trusted.
 *
 * The command's own guards are what make the hard cases safe, and none of them is re-implemented here: the UPDATE is gated on
 * `status = 'proposed'` (so a decided row is immutable and a replay reports `already_decided`), and 0075's partial unique index
 * plus the command's `unique_violation` handler turn a lost race into `accepted_exists` — leaving the losing candidate a
 * proposal. An unrecognised status is treated as a failure rather than passed through, so no unnamed state reaches the screen,
 * and no database error text ever does.
 */
export async function decideApplicationMatch(matchId: string, decision: Decision): Promise<DecideResult> {
  const gate = await accessGate();
  if (!gate.ok) return { ok: false, error: "not_allowed" };

  const supabase = await createClient();
  const { data, error } = await rpcOf(supabase)("product_decide_application_match", {
    p_tenant_id: gate.tenantId,
    p_match_id: matchId,
    p_decision: decision,
  });
  if (error) {
    console.error("[data/application-match-review] decision failed");
    return { ok: false, error: "query_failed" };
  }

  const status = (data as { status?: unknown } | null)?.status;
  if (typeof status !== "string" || !isDecideStatus(status)) {
    console.error("[data/application-match-review] decision returned an unrecognised status");
    return { ok: false, error: "query_failed" };
  }
  return { ok: true, status };
}
