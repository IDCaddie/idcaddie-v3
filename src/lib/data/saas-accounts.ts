// Phase 9 — the SERVER-ONLY read layer for canonical SaaS account evidence (migrations 0076/0077/0078).
//
// Same shape as access-repository.ts and for the same reasons: it invokes only the 0078 `product_*` RPCs, never a table;
// the tenant id comes from `accessGate()` and every RPC re-verifies it via has_tenant_role; every response is validated at
// runtime; and a failure becomes a safe label, never a Supabase error.
//
// This is a DIFFERENT model from src/lib/data/app-users.ts and /people, which read the pre-0076 `app_users` table. Nothing
// in the Slack path writes that table, so the two must not be conflated — an account discovered by a connector lands in
// `app_accounts` and is only visible through here.

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { accessGate, type ListResult } from "./access-repository";

export { accessGate };

type RpcFn = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function callRpc(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: "query_failed" }> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  const { data, error } = await rpc(name, args);
  if (error) { console.error(`[data/saas-accounts] rpc query_failed: ${name}`); return { ok: false, error: "query_failed" }; }
  return { ok: true, data };
}

// ── Row contracts. Bounded vocabularies are re-asserted here as well as in the database: a value outside them means the
// ── two have drifted, and rendering an unrecognised status is how a customer ends up reading a raw provider token.
export const ACCOUNT_KINDS = ["human", "bot", "service", "unknown"] as const;
export const ACCOUNT_STATUSES = ["active", "inactive", "deleted", "unknown"] as const;
export const MATCH_STATES = ["matched", "proposed", "unmatched"] as const;

const accountRowSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  provider: z.string(),
  workspace_external_id: z.string().nullable(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  account_kind: z.enum(ACCOUNT_KINDS),
  account_status: z.enum(ACCOUNT_STATUSES),
  is_admin: z.boolean().nullable(),
  sync_status: z.string(),
  stale_since: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  first_seen_at: z.string().nullable(),
  match_state: z.enum(MATCH_STATES),
  match_confidence: z.string().nullable(),
  match_method: z.string().nullable(),
  total_count: z.union([z.number(), z.string()]).nullable(),
});

const groupRowSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  provider: z.string(),
  workspace_external_id: z.string().nullable(),
  name: z.string().nullable(),
  handle: z.string().nullable(),
  description: z.string().nullable(),
  reported_member_count: z.number().nullable(),
  known_member_count: z.number().nullable(),
  is_active: z.boolean().nullable(),
  sync_status: z.string(),
  stale_since: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  total_count: z.union([z.number(), z.string()]).nullable(),
});

const capabilityRowSchema = z.object({
  connection_id: z.string(),
  capability: z.string(),
  state: z.string(),
  reason_code: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_attempt_at: z.string().nullable(),
  observed_count: z.number().nullable(),
});

const bucket = z.object({
  current: z.number(), stale: z.number(), totalEvidence: z.number(), lastSeenAt: z.string().nullable(),
}).partial({ lastSeenAt: true });

const countsSchema = z.object({
  accounts: bucket.extend({
    humans: z.number(), bots: z.number(), unknownKind: z.number(), admins: z.number(),
    active: z.number(), inactive: z.number(), deleted: z.number(),
  }),
  groups: bucket,
  matching: z.object({
    humans: z.number(), matched: z.number(), proposed: z.number(), unmatched: z.number(), withoutEmail: z.number(),
  }),
});

export type SaasAccountRow = z.infer<typeof accountRowSchema>;
export type SaasGroupRow = z.infer<typeof groupRowSchema>;
export type SaasCapabilityRow = z.infer<typeof capabilityRowSchema>;
export type SaasCounts = z.infer<typeof countsSchema>;

// A page carries the TOTAL so the UI can say "showing 50 of 312" instead of implying 50 is all there is.
export type Page<T> = { rows: T[]; total: number };

export type AccountFilters = {
  connectionId?: string | null;
  includeStale?: boolean;
  search?: string | null;
  kind?: string | null;
  status?: string | null;
  matchState?: string | null;
  limit?: number;
  offset?: number;
};

const MAX_PAGE = 200;
const clamp = (n: number | undefined, d: number) => Math.min(Math.max(Math.trunc(n ?? d), 1), MAX_PAGE);
// A blank search box must mean "no filter", not "match the empty string".
const trimmed = (s: string | null | undefined) => { const v = (s ?? "").trim(); return v.length > 0 ? v : null; };
const totalOf = (rows: { total_count: number | string | null }[]) =>
  rows.length === 0 ? 0 : Number(rows[0].total_count ?? rows.length);

function parseRows<T>(schema: z.ZodType<T>, data: unknown): T[] {
  if (!Array.isArray(data)) return [];
  const out: T[] = [];
  for (const r of data) {
    const p = schema.safeParse(r);
    // A row that fails its contract is DROPPED, not rendered. The alternative is showing a value from a vocabulary the UI
    // has no label for, which reads to a customer as a bug in their data rather than in ours.
    if (p.success) out.push(p.data);
    else console.error("[data/saas-accounts] dropped a row that failed its contract");
  }
  return out;
}

export async function listSaasAccounts(tenantId: string, f: AccountFilters = {}): Promise<ListResult<Page<SaasAccountRow>>> {
  const r = await callRpc("product_app_accounts", {
    p_tenant_id: tenantId,
    p_connection_id: f.connectionId ?? null,
    p_include_stale: f.includeStale !== false,
    p_search: trimmed(f.search),
    p_kind: f.kind ?? null,
    p_status: f.status ?? null,
    p_match_state: f.matchState ?? null,
    p_limit: clamp(f.limit, 50),
    p_offset: Math.max(0, Math.trunc(f.offset ?? 0)),
  });
  if (!r.ok) return r;
  const rows = parseRows(accountRowSchema, r.data);
  return { ok: true, data: { rows, total: totalOf(rows) } };
}

export async function listSaasGroups(
  tenantId: string,
  f: Pick<AccountFilters, "connectionId" | "includeStale" | "search" | "limit" | "offset"> = {},
): Promise<ListResult<Page<SaasGroupRow>>> {
  const r = await callRpc("product_app_account_groups", {
    p_tenant_id: tenantId,
    p_connection_id: f.connectionId ?? null,
    p_include_stale: f.includeStale !== false,
    p_search: trimmed(f.search),
    p_limit: clamp(f.limit, 50),
    p_offset: Math.max(0, Math.trunc(f.offset ?? 0)),
  });
  if (!r.ok) return r;
  const rows = parseRows(groupRowSchema, r.data);
  return { ok: true, data: { rows, total: totalOf(rows) } };
}

export async function getSaasCounts(tenantId: string, connectionId: string | null = null): Promise<ListResult<SaasCounts>> {
  const r = await callRpc("product_app_account_counts", { p_tenant_id: tenantId, p_connection_id: connectionId });
  if (!r.ok) return r;
  const p = countsSchema.safeParse(r.data);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "query_failed" };
}

export async function listConnectorCapabilities(tenantId: string, connectionId: string | null = null): Promise<ListResult<SaasCapabilityRow[]>> {
  const r = await callRpc("product_connector_capabilities", { p_tenant_id: tenantId, p_connection_id: connectionId });
  if (!r.ok) return r;
  return { ok: true, data: parseRows(capabilityRowSchema, r.data) };
}

// ── Writes. Both are deliberate, human-initiated actions; neither runs on a read.
export async function proposeIdentityMatches(tenantId: string, connectionId: string | null = null): Promise<ListResult<{ considered: number; proposed: number; ambiguous: number }>> {
  const r = await callRpc("product_propose_app_account_identity_matches", { p_tenant_id: tenantId, p_connection_id: connectionId });
  if (!r.ok) return r;
  const p = z.object({ considered: z.number(), proposed: z.number(), ambiguous: z.number() }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "query_failed" };
}

export async function decideIdentityMatch(tenantId: string, matchId: string, decision: "accepted" | "rejected"): Promise<ListResult<{ updated: number }>> {
  const r = await callRpc("product_decide_app_account_identity_match", { p_tenant_id: tenantId, p_match_id: matchId, p_decision: decision });
  if (!r.ok) return r;
  const p = z.object({ updated: z.number() }).safeParse(r.data);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "query_failed" };
}
