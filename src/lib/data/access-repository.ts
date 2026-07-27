// Phase 15 Part 1 PR B — the SERVER-ONLY access-product repository: the ONLY module that invokes the migration-0061 read RPCs. It imports
// the user-scoped server Supabase client (anon-key, cookie-bound, RLS-governed — NEVER service-role), so it is transitively server-only
// (importing it into a client bundle fails the build). `accessGate()` resolves the authenticated user + active tenant via the existing
// trusted tenant-context (RLS-backed, never a JWT claim, never a caller-supplied tenant_id) and verifies owner/admin ONCE per request; the
// verified tenant id is then passed to the accessors, and EVERY RPC re-verifies it via has_tenant_role (the authoritative boundary — a wrong
// or unverified tenant id returns empty). It queries NO canonical table directly, performs NO write, validates every RPC response at
// runtime (access-rpc-types), and maps failures to safe labels. No raw Supabase error, id, or label is ever logged.

import { createClient } from "@/lib/supabase/server";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import {
  identityRowSchema, groupRowSchema, applicationRowSchema, membershipRowSchema, userAssignmentRowSchema, groupAssignmentRowSchema,
  countsSchema, identitySubgraphSchema, applicationSubgraphSchema, parseRows,
  type IdentityRow, type GroupRow, type ApplicationRow, type MembershipRow, type UserAssignmentRow, type GroupAssignmentRow,
  type Counts, type IdentitySubgraph, type ApplicationSubgraph,
} from "./access-rpc-types";

const OWNER_ADMIN_ROLES: readonly string[] = ["owner", "admin"];
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 100;

export type Gate = { ok: true; tenantId: string } | { ok: false };
export type ListResult<T> = { ok: true; data: T } | { ok: false; error: "query_failed" };
export type EntityResult<T> = { ok: true; data: T } | { ok: false; error: "not_found" | "query_failed" };
export type ListOptions = { includeStale?: boolean; afterId?: string | null; limit?: number };

// The 0061 RPCs are absent from the generated Database types, so narrow-cast the .rpc call boundary (never `any` the whole client).
type RpcFn = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

// Resolve + verify the active tenant is one the caller owns/administers. tenant_id is derived server-side, never from a caller argument.
export async function accessGate(): Promise<Gate> {
  const ctx = await resolveTenantContext();
  const tenantId = ctx?.activeTenant?.id ?? null;
  const role = ctx?.activeTenant?.role ?? null;
  if (tenantId !== null && role !== null && OWNER_ADMIN_ROLES.includes(role)) return { ok: true, tenantId };
  return { ok: false };
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: "query_failed" }> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;
  const { data, error } = await rpc(name, args);
  if (error) { console.error(`[data/access] rpc query_failed: ${name}`); return { ok: false, error: "query_failed" }; }
  return { ok: true, data };
}

const clampLimit = (n: number | undefined): number => Math.min(Math.max(Math.trunc(n ?? DEFAULT_PAGE), 1), MAX_PAGE);
const listArgs = (tenantId: string, o: ListOptions) => ({ p_tenant_id: tenantId, p_include_stale: o.includeStale === true, p_after_id: o.afterId ?? null, p_limit: clampLimit(o.limit) });

// tenantId MUST come from accessGate(); the RPC re-verifies via has_tenant_role. The counts function is stale-AGNOSTIC (it declares no
// p_include_stale and counts all rows — the correct conservative bound for the overview's too-large gate), so no stale arg is passed.
export async function getAccessCounts(tenantId: string): Promise<ListResult<Counts>> {
  const r = await callRpc("product_directory_access_counts", { p_tenant_id: tenantId });
  if (!r.ok) return r;
  const p = countsSchema.safeParse(r.data);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "query_failed" };
}

async function list<T>(rpc: string, schema: Parameters<typeof parseRows<T>>[0], tenantId: string, o: ListOptions): Promise<ListResult<T[]>> {
  const r = await callRpc(rpc, listArgs(tenantId, o));
  if (!r.ok) return r;
  return { ok: true, data: parseRows(schema, r.data) };
}
export const listDirectoryIdentities = (t: string, o: ListOptions = {}): Promise<ListResult<IdentityRow[]>> => list("product_list_directory_identities", identityRowSchema, t, o);
export const listDirectoryGroups = (t: string, o: ListOptions = {}): Promise<ListResult<GroupRow[]>> => list("product_list_directory_groups", groupRowSchema, t, o);
export const listDirectoryApplications = (t: string, o: ListOptions = {}): Promise<ListResult<ApplicationRow[]>> => list("product_list_directory_applications", applicationRowSchema, t, o);
export const listGroupMemberships = (t: string, o: ListOptions = {}): Promise<ListResult<MembershipRow[]>> => list("product_list_group_memberships", membershipRowSchema, t, o);
export const listUserAssignments = (t: string, o: ListOptions = {}): Promise<ListResult<UserAssignmentRow[]>> => list("product_list_user_assignments", userAssignmentRowSchema, t, o);
export const listGroupAssignments = (t: string, o: ListOptions = {}): Promise<ListResult<GroupAssignmentRow[]>> => list("product_list_group_assignments", groupAssignmentRowSchema, t, o);

// Entity subgraphs: a null jsonb (denied / foreign / missing) -> not_found, all indistinguishable.
export async function getIdentityAccessSubgraph(tenantId: string, identityId: string, includeStale = false): Promise<EntityResult<IdentitySubgraph>> {
  const r = await callRpc("product_identity_access_subgraph", { p_tenant_id: tenantId, p_identity_id: identityId, p_include_stale: includeStale });
  if (!r.ok) return r;
  if (r.data === null || r.data === undefined) return { ok: false, error: "not_found" };
  const p = identitySubgraphSchema.safeParse(r.data);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "query_failed" };
}
export async function getApplicationAccessSubgraph(tenantId: string, applicationId: string, includeStale = false): Promise<EntityResult<ApplicationSubgraph>> {
  const r = await callRpc("product_application_access_subgraph", { p_tenant_id: tenantId, p_application_id: applicationId, p_include_stale: includeStale });
  if (!r.ok) return r;
  if (r.data === null || r.data === undefined) return { ok: false, error: "not_found" };
  const p = applicationSubgraphSchema.safeParse(r.data);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "query_failed" };
}
