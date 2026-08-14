// Phase 17 — the SERVER-ONLY tenant loader for cross-source governance, and the thin orchestration around it.
//
// THREE OWNERS, KEPT APART ON PURPOSE:
//   * this loader owns WHAT EVIDENCE IS AVAILABLE TO EVALUATE;
//   * `src/lib/server/cross-source-governance/` owns WHAT THAT EVIDENCE MEANS;
//   * migration 0083 owns the FINDING LIFECYCLE.
// There is no rule logic below — no severity, no subject, no threshold, no "if this then a finding". Equally there is
// no SQL in the engine and no lifecycle arithmetic here: closing, reopening and first/last-seen are 0083's, and
// re-deriving them in TypeScript would give the product two answers to one question.
//
// It reads ONLY the authorized product RPCs (0061 / 0078 / 0085 / 0089 / 0090) plus `connectors`, through the user-scoped,
// cookie-bound, RLS-governed server client — the same one `access-repository` uses. NEVER service-role. Every RPC
// re-verifies the tenant via `has_tenant_role`, so the tenant id is checked twice: once here by `accessGate()` and
// again inside each function. No provider adapter is imported and no provider name is ever compared to a literal.
//
// ══ THE RULE THIS MODULE EXISTS TO HONOUR ════════════════════════════════════════════════════════════════════════════
// SUPPORTED ≠ COMPLETE · UNSUPPORTED ≠ ZERO · INCOMPLETE ≠ ABSENT · STALE ≠ CURRENT · READ FAILURE ≠ EMPTY RESULT.
//
// The last one is the one a loader gets wrong. A failed read and a successful empty read are the same `[]` in most
// code, and once they are the same the engine cannot tell "this tenant has no orphaned accounts" from "we could not
// look" — and 0083 would then close findings on the strength of a query that never ran. So a failed required read
// fails the WHOLE evaluation (`{ ok: false }`); nothing is synced, and nothing closes. Failing loudly is always
// available; fabricating completeness is not.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";
import { evaluateCrossSourceGovernance } from "@/lib/server/cross-source-governance/evaluate";
import type {
  AppAccountRow, ApplicationCandidateRow, ApplicationMatchRow, ApplicationMatcherState, CrossSourceGraph,
  DirectoryApplicationRow, IdentityAccountRow, PersonAccountLinkRow, SourceCapability,
} from "@/lib/server/cross-source-governance/types";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("cross-source-governance-loader is server-only and must not be imported in client code");
}

// ── Bounded failure vocabulary ───────────────────────────────────────────────────────────────────────────────────────
// Deliberately three values. A caller may render or log any of them; none can carry SQL, a URL, a PostgREST payload, a
// row, a token or a stack. The raw error is dropped at the boundary below and never returned.
export type LoaderError = "not_authorized" | "query_failed" | "page_limit_exceeded" | "pagination_contract_violated";
export type LoadResult =
  | { readonly ok: true; readonly input: CrossSourceGraph }
  | { readonly ok: false; readonly error: LoaderError };

// Every page request asks for the RPC's own maximum. 0061 caps at 100, 0078 and 0085 at 500; asking for more is
// clamped server-side, so one constant per family is enough and none of them can widen a page.
const PAGE_DIRECTORY = 100;
const PAGE_WIDE = 500;
// 0090 clamps to 200, and its page counts PARENTS rather than rows — see `loadApplicationCandidates`.
const PAGE_CANDIDATES = 200;
// A backstop against a cursor that stops advancing: 400 pages of 500 is 200k rows, far beyond any real tenant, and an
// evaluation that needs more is a bug rather than a big customer. Hitting it FAILS rather than silently truncating —
// a partial load would understate the estate and could close findings that are still true.
const MAX_PAGES = 400;

const uuid = z.string().min(1);
const syncStatus = z.enum(["current", "stale", "review_required", "disconnected"]);
const nullableBool = z.boolean().nullable().optional().transform(v => v ?? null);

// Strict-by-default parsing (zod strips unknown keys) is the defence that a column a future RPC change happens to add —
// an email, a rationale — cannot reach the engine even if the contract drifts.
const appAccountSchema = z.object({
  id: uuid, connection_id: uuid, provider: z.string().min(1), sync_status: syncStatus,
  account_kind: z.enum(["human", "bot", "service", "unknown"]),
  account_status: z.enum(["active", "inactive", "deleted", "unknown"]),
  is_admin: nullableBool,
});
const identitySchema = z.object({
  id: uuid, connection_id: uuid, provider: z.string().min(1), sync_status: syncStatus, is_active: nullableBool,
});
const directoryApplicationSchema = z.object({
  id: uuid, connection_id: uuid, provider: z.string().min(1), sync_status: syncStatus,
});
const personLinkSchema = z.object({
  id: uuid, person_id: uuid,
  identity_account_id: uuid.nullable().optional().transform(v => v ?? null),
  app_account_id: uuid.nullable().optional().transform(v => v ?? null),
  status: z.enum(["proposed", "accepted", "rejected"]),
});
const applicationMatchSchema = z.object({
  id: uuid, directory_application_id: uuid, status: z.enum(["proposed", "accepted", "rejected"]),
});
const applicationCandidateSchema = z.object({
  directory_application_id: uuid, app_product_id: uuid, app_id: uuid.nullable().optional().transform(v => v ?? null),
});
const capabilitySchema = z.object({
  connection_id: uuid, capability: z.string().min(1),
  state: z.enum(["available", "incomplete", "failed", "plan_dependent", "permission_dependent", "unavailable"]),
});
const matcherStateSchema = z.object({
  has_ever_run: z.boolean(),
  status: z.enum(["running", "completed", "failed"]).nullable().optional().transform(v => v ?? null),
  last_completed_at: z.string().nullable().optional().transform(v => v ?? null),
});
const connectorSchema = z.object({ id: uuid, provider: z.string().min(1) });

// ── The I/O seam ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Injected so the loader is testable without a database, and so the ONLY implementation that touches Supabase is the
// default one below. A test supplies a fake; nothing else changes.
export type LoaderIo = {
  readonly rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  readonly connectors: (tenantId: string) => Promise<{ data: unknown; error: unknown }>;
};

export async function createLoaderIo(): Promise<LoaderIo> {
  const supabase = await createClient();
  type RpcFn = (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  return {
    rpc: async (name, args) => await rpc(name, args),
    // `connectors` carries a table-wide `authenticated` SELECT (0018) filtered by tenant-member RLS — an existing
    // boundary, not a new one. Only (id, provider) is selected: the loader needs a provider label for provenance and
    // nothing else from this table.
    connectors: async tenantId =>
      await supabase.from("connectors").select("id, provider").eq("tenant_id", tenantId),
  };
}

// A raw error is observed here and NOWHERE else. It is not returned, not attached, and not logged — only the RPC name
// is, because a PostgREST message can carry a predicate, a column list, or a row value.
type Fetched<T> = { ok: true; rows: T[] } | { ok: false; error: LoaderError };

async function callRpc(io: LoaderIo, name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: LoaderError }> {
  try {
    const { data, error } = await io.rpc(name, args);
    if (error) {
      console.error(`[governance/loader] rpc query_failed: ${name}`);
      return { ok: false, error: "query_failed" };
    }
    return { ok: true, data };
  } catch {
    // A thrown transport error is the same class of unknown as a returned one, and must not escape as a stack.
    console.error(`[governance/loader] rpc threw: ${name}`);
    return { ok: false, error: "query_failed" };
  }
}

/** Ids must strictly increase within a page and past the cursor that produced it. */
function strictlyIncreasing<T extends { id: string }>(batch: readonly T[], after: string | null): boolean {
  let prev = after;
  for (const row of batch) {
    if (prev !== null && row.id <= prev) return false;
    prev = row.id;
  }
  return true;
}

/**
 * Parse a page, reporting how many rows were DROPPED rather than silently swallowing them.
 *
 * #418 made a validation-dropped row fail the app-account read, because 0078's `count(*) over ()` exposed the short
 * set. 0089 has no total — a cursor does not need one — so that guarantee has to be kept some other way, and the
 * honest way is the direct one: a row we could not parse is a row we did not read. Continuing would withhold that
 * account's finding while leaving its connection closure-eligible, which is the same false-closure harm the total was
 * catching. So it now holds for EVERY read rather than only the one that happened to return a count.
 */
function parsePage<T>(schema: z.ZodType<T>, data: unknown): { rows: T[]; dropped: number } {
  if (!Array.isArray(data)) return { rows: [], dropped: 0 };
  const rows: T[] = [];
  let dropped = 0;
  for (const r of data) {
    const p = schema.safeParse(r);
    if (p.success) rows.push(p.data);
    else dropped++;
  }
  return { rows, dropped };
}

/**
 * Page a cursor-based RPC to EXHAUSTION.
 *
 * "Page one is enough" is the quiet way a loader lies: the engine would see a truthful-looking subset and conclude that
 * accounts beyond row 500 have no owner. The cursor is the last row's id, which every 0061/0085 read orders by, so
 * pages cannot overlap or skip.
 */
async function loadAllByCursor<T extends { id: string }>(
  io: LoaderIo, name: string, schema: z.ZodType<T>, baseArgs: Record<string, unknown>, pageSize: number,
): Promise<Fetched<T>> {
  const rows: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRpc(io, name, { ...baseArgs, p_after_id: after, p_limit: pageSize });
    if (!r.ok) return r;
    const parsed = parsePage(schema, r.data);
    if (parsed.dropped > 0) {
      console.error(`[governance/loader] ${parsed.dropped} row(s) failed their contract: ${name}`);
      return { ok: false, error: "pagination_contract_violated" };
    }
    const batch = parsed.rows;
    // Strict monotonicity, enforced rather than trusted. A repeated or backward id means the canonical read is
    // malformed — and a duplicated app_account would reach rule 4 as one person holding two accounts in one
    // connection, i.e. a governance finding accusing somebody of a duplicate that does not exist. Deduplicating
    // silently would hide the broken read AND present incomplete evidence as complete, so this FAILS instead.
    if (!strictlyIncreasing(batch, after)) {
      console.error(`[governance/loader] non-monotonic cursor page: ${name}`);
      return { ok: false, error: "pagination_contract_violated" };
    }
    rows.push(...batch);
    // A short page is the last page. A full page whose rows all failed validation would otherwise stall the cursor, so
    // the raw length decides continuation and the parsed rows decide the cursor.
    const raw = Array.isArray(r.data) ? r.data.length : 0;
    if (raw < pageSize) return { ok: true, rows };
    const last = batch.length > 0 ? batch[batch.length - 1].id : null;
    // The terminal guard on the loop itself. It is SUBSUMED today — a page that failed to advance would already have
    // tripped `strictlyIncreasing` above, and a page that parsed to nothing would have tripped the drop check — so
    // mutating it away leaves the suite green. It stays because loop termination should not depend implicitly on two
    // guards written for other reasons: if either is ever relaxed, this is what still stops an infinite walk. Noted
    // rather than deleted, and noted rather than claimed as tested.
    if (last === null || last === after) {
      console.error(`[governance/loader] cursor did not advance: ${name}`);
      return { ok: false, error: "pagination_contract_violated" };
    }
    after = last;
  }
  console.error(`[governance/loader] page limit exceeded: ${name}`);
  return { ok: false, error: "page_limit_exceeded" };
}

/**
 * Walk 0090's candidate feed to exhaustion. Phase 18D — the ONE read that lets rule 5 say WHY it is open.
 *
 * It cannot use `loadAllByCursor`, and the reason is the contract rather than the code: 0090 pages by PARENT, so a page
 * legitimately returns several rows per directory application and may return more rows than `p_limit`. Row count says
 * nothing about whether the walk is done — the number of distinct parents does — and the cursor is the last PARENT, so
 * an application's instance set is never split across a boundary. Reusing the row cursor here would end the walk early
 * on the first multi-instance application and silently reclassify every application after it as `product_unresolved`.
 *
 * Every violation FAILS the read rather than repairing it, for the same reason as every other read in this module: a
 * short candidate feed is indistinguishable from a tenant whose products are genuinely unsettled, and the engine would
 * turn that into remediation advice telling a customer to identify software they have already identified.
 */
async function loadApplicationCandidates(
  io: LoaderIo, tenantId: string,
): Promise<Fetched<z.infer<typeof applicationCandidateSchema>>> {
  const rows: z.infer<typeof applicationCandidateSchema>[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await callRpc(io, "product_application_match_candidates", {
      p_tenant_id: tenantId, p_after_directory_application_id: after, p_limit: PAGE_CANDIDATES,
    });
    if (!r.ok) return r;
    const parsed = parsePage(applicationCandidateSchema, r.data);
    if (parsed.dropped > 0) {
      console.error("[governance/loader] candidate row failed its contract: product_application_match_candidates");
      return { ok: false, error: "pagination_contract_violated" };
    }

    // 0090 orders by (parent, app), so parents must STRICTLY ASCEND across the whole walk and each one's rows must be
    // contiguous. One comparison enforces all of it: a parent at or before the cursor means this page overlaps one
    // already consumed, a parent below the previous one means the ordering broke, and a parent reappearing after
    // another intervened is the same violation — the read split a group and rule 5 would classify from half of it.
    let parentCount = 0;
    let lastParent: string | null = null;
    for (const row of parsed.rows) {
      const parent = row.directory_application_id;
      if (parent !== lastParent) {
        // `<= after` rejects the page that re-serves the cursor's own parent, which `< lastParent` cannot see because
        // that parent is the first one on the page and has nothing before it to compare against.
        if ((lastParent !== null && parent < lastParent) || (after !== null && parent <= after)) {
          console.error("[governance/loader] non-monotonic candidate cursor");
          return { ok: false, error: "pagination_contract_violated" };
        }
        lastParent = parent;
        parentCount++;
      }
      rows.push(row);
    }

    if (parentCount === 0) return { ok: true, rows };
    after = lastParent;
    // A short PARENT page is the last page, because the limit is on parents. Comparing ROW count would not TRUNCATE —
    // the LEFT JOIN yields at least one row per parent, so `rows < limit` implies `parents < limit` and the walk cannot
    // end early — but it would keep asking for pages after the estate is exhausted, once per multi-instance
    // application. Stated as the round-trip fact it is rather than the data-loss one it is not; the test that fails on
    // a row count is counting calls, not rows.
    if (parentCount < PAGE_CANDIDATES) return { ok: true, rows };
  }
  console.error("[governance/loader] page limit exceeded: product_application_match_candidates");
  return { ok: false, error: "page_limit_exceeded" };
}

/**
 * Assemble one tenant's canonical evidence into the engine's exact input.
 *
 * Every read is a CURSOR walk. `product_app_accounts_for_governance` (0089) exists precisely so this one can be:
 * `product_app_accounts` (0078) still serves the SaaS accounts page, where a human needs alphabetical order, an offset
 * pager and a total — and where cursor-paging would hand them an alphabetically random page. Governance asks a
 * different question ("every account, exactly once"), so it gets its own contract rather than bending that one.
 *
 * `tenantId` MUST already be verified by `accessGate()`. Passing an unverified id is not a hole — every RPC re-checks
 * it — but it is the caller's contract, and the double check is the defence in depth worth keeping.
 *
 * Stale rows are loaded DELIBERATELY (`p_include_stale: true`). The engine decides what staleness means per rule; a
 * loader that filtered them would silently answer a question the rules are supposed to answer, and "we did not fetch
 * it" would become indistinguishable from "it is not there".
 */
export async function loadCrossSourceGovernanceInput(tenantId: string, io: LoaderIo): Promise<LoadResult> {
  const [accounts, identities, applications, links, matches, candidates] = await Promise.all([
    loadAllByCursor(io, "product_app_accounts_for_governance", appAccountSchema,
      { p_tenant_id: tenantId }, PAGE_WIDE),
    loadAllByCursor(io, "product_list_directory_identities", identitySchema,
      { p_tenant_id: tenantId, p_connection_id: null, p_provider: null, p_include_stale: true }, PAGE_DIRECTORY),
    loadAllByCursor(io, "product_list_directory_applications", directoryApplicationSchema,
      { p_tenant_id: tenantId, p_connection_id: null, p_provider: null, p_include_stale: true }, PAGE_DIRECTORY),
    loadAllByCursor(io, "product_person_account_links", personLinkSchema, { p_tenant_id: tenantId }, PAGE_WIDE),
    loadAllByCursor(io, "product_application_matches", applicationMatchSchema, { p_tenant_id: tenantId }, PAGE_WIDE),
    loadApplicationCandidates(io, tenantId),
  ]);

  // Checked one at a time rather than in a loop: a loop cannot narrow each union member for the compiler, and the
  // narrowing is what guarantees `.rows` below is only reached on the success branch.
  if (!accounts.ok) return { ok: false, error: accounts.error };
  if (!identities.ok) return { ok: false, error: identities.error };
  if (!applications.ok) return { ok: false, error: applications.error };
  if (!links.ok) return { ok: false, error: links.error };
  if (!matches.ok) return { ok: false, error: matches.error };
  // A failed candidate read must NOT fall through as an empty feed: rule 5 reads absence from that feed as "this
  // application's canonical product is unresolved", so a read we never completed would become remediation advice.
  if (!candidates.ok) return { ok: false, error: candidates.error };

  const capabilitiesRaw = await callRpc(io, "product_connector_capabilities",
    { p_tenant_id: tenantId, p_connection_id: null });
  if (!capabilitiesRaw.ok) return { ok: false, error: capabilitiesRaw.error };

  const matcherRaw = await callRpc(io, "product_application_matcher_state", { p_tenant_id: tenantId });
  if (!matcherRaw.ok) return { ok: false, error: matcherRaw.error };

  let connectorsResult;
  try {
    connectorsResult = await io.connectors(tenantId);
  } catch {
    console.error("[governance/loader] connectors read threw");
    return { ok: false, error: "query_failed" };
  }
  if (connectorsResult.error) {
    console.error("[governance/loader] connectors read query_failed");
    return { ok: false, error: "query_failed" };
  }

  // `product_connector_capabilities` does not return a provider, so it is joined from `connectors`. A capability naming
  // a connection this tenant does not own is DROPPED rather than defaulted — an unattributable capability cannot be
  // evidence, and inventing a provider label for it would put a fabricated source into the completeness set.
  const providerByConnection = new Map(
    parsePage(connectorSchema, connectorsResult.data).rows.map(c => [c.id, c.provider] as const),
  );
  const capabilities: SourceCapability[] = parsePage(capabilitySchema, capabilitiesRaw.data).rows.flatMap(c => {
    const provider = providerByConnection.get(c.connection_id);
    if (provider === undefined) return [];
    // The engine's capability vocabulary is a closed set; anything outside it is not a capability it can reason about.
    if (c.capability !== "identity" && c.capability !== "app_accounts" && c.capability !== "directory_applications") {
      return [];
    }
    return [{ connectionId: c.connection_id, provider, capability: c.capability, state: c.state }];
  });

  // The matcher read returns exactly one row for an authorized caller. Zero rows means the tenant-role gate refused —
  // which cannot be reported as "never ran", because that is a claim about the estate rather than about our access.
  const matcherRows = parsePage(matcherStateSchema, matcherRaw.data).rows;
  if (matcherRows.length !== 1) {
    console.error("[governance/loader] matcher state unreadable");
    return { ok: false, error: "not_authorized" };
  }
  const m = matcherRows[0];
  const matcherState: ApplicationMatcherState = {
    hasEverRun: m.has_ever_run, status: m.status, lastCompletedAt: m.last_completed_at,
  };

  const input: CrossSourceGraph = {
    tenantId,
    capabilities,
    appAccounts: accounts.rows.map(toAppAccount),
    identityAccounts: identities.rows.map(toIdentity),
    directoryApplications: applications.rows.map(toDirectoryApplication),
    personAccountLinks: links.rows.map(toPersonLink),
    applicationMatches: matches.rows.map(toApplicationMatch),
    applicationCandidates: candidates.rows.map(toApplicationCandidate),
    matcherState,
  };
  return { ok: true, input };
}

// Snake-case row -> engine shape. Nothing is computed, defaulted or inferred here; a null stays a null, because
// `is_admin: null` means the provider did not say and the engine treats that differently from `false`.
const toAppAccount = (r: z.infer<typeof appAccountSchema>): AppAccountRow => ({
  id: r.id, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status,
  accountKind: r.account_kind, accountStatus: r.account_status, isAdmin: r.is_admin,
});
const toIdentity = (r: z.infer<typeof identitySchema>): IdentityAccountRow => ({
  id: r.id, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status, isActive: r.is_active,
});
const toDirectoryApplication = (r: z.infer<typeof directoryApplicationSchema>): DirectoryApplicationRow => ({
  id: r.id, connectionId: r.connection_id, provider: r.provider, syncStatus: r.sync_status,
});
const toPersonLink = (r: z.infer<typeof personLinkSchema>): PersonAccountLinkRow => ({
  personId: r.person_id, identityAccountId: r.identity_account_id, appAccountId: r.app_account_id, status: r.status,
});
const toApplicationMatch = (r: z.infer<typeof applicationMatchSchema>): ApplicationMatchRow => ({
  directoryApplicationId: r.directory_application_id, status: r.status,
});
const toApplicationCandidate = (r: z.infer<typeof applicationCandidateSchema>): ApplicationCandidateRow => ({
  directoryApplicationId: r.directory_application_id, appProductId: r.app_product_id, appId: r.app_id,
});

// ── Orchestration ────────────────────────────────────────────────────────────────────────────────────────────────────
export type EvaluationSummary = {
  readonly reported: number; readonly opened: number; readonly reopened: number;
  readonly refreshed: number; readonly closed: number; readonly withheldFromClosure: number;
  readonly evaluatedRules: readonly string[];
  readonly withheldRules: readonly { readonly ruleId: string; readonly reason: string }[];
};
export type EvaluateResult =
  | { readonly ok: true; readonly summary: EvaluationSummary }
  | { readonly ok: false; readonly error: LoaderError };

const syncResultSchema = z.object({
  reported: z.number(), opened: z.number(), reopened: z.number(),
  refreshed: z.number(), closed: z.number(), withheld_from_closure: z.number(),
});

/**
 * Authorize → load → evaluate (pure) → reconcile through 0083.
 *
 * The engine is called with data and returns data; the only thing that touches the database is this function's two
 * boundaries. `complete_connection_ids` is the engine's own `completeConnectionIds`, which contains exactly the
 * connections whose capability was proven `available` — so a stale, failed, plan-limited, permission-limited,
 * unsupported or simply undeclared source can never license a closure. A load failure returns before any sync, so a
 * failed read cannot close a finding.
 */
export async function evaluateTenantCrossSourceGovernance(io?: LoaderIo): Promise<EvaluateResult> {
  const gate = await accessGate();
  if (!gate.ok) return { ok: false, error: "not_authorized" };
  const resolvedIo = io ?? (await createLoaderIo());

  const loaded = await loadCrossSourceGovernanceInput(gate.tenantId, resolvedIo);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const evaluation = evaluateCrossSourceGovernance(loaded.input);

  const synced = await callRpc(resolvedIo, "product_sync_governance_findings", {
    p_tenant_id: gate.tenantId,
    // ALWAYS `cross_source`. A provider-local reconciliation is Phase 14's, and 0083 reconciles only within the engine
    // it is told about — so this literal is what keeps this path from ever resolving a provider-local finding.
    p_engine: "cross_source",
    p_rule_version: evaluation.ruleVersion,
    p_findings: evaluation.findings,
    p_complete_connection_ids: evaluation.completeConnectionIds,
  });
  if (!synced.ok) return { ok: false, error: synced.error };

  const parsed = syncResultSchema.safeParse(synced.data);
  if (!parsed.success) {
    console.error("[governance/loader] sync returned an unexpected shape");
    return { ok: false, error: "query_failed" };
  }
  return {
    ok: true,
    summary: {
      reported: parsed.data.reported, opened: parsed.data.opened, reopened: parsed.data.reopened,
      refreshed: parsed.data.refreshed, closed: parsed.data.closed,
      withheldFromClosure: parsed.data.withheld_from_closure,
      evaluatedRules: evaluation.evaluatedRules,
      withheldRules: evaluation.withheldRules,
    },
  };
}
