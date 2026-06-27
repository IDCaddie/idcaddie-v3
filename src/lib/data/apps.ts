import { createClient } from "@/lib/supabase/server";

// Server-only, read-only data access for `apps`. This is the canonical DAL pattern the
// upcoming app-inventory screen (build-sequence Stage 4) will use; contracts/orgs helpers
// follow the same shape when their screens land.
//
// Boundary: this module imports the user-scoped server client (which imports next/headers),
// so it is server-only — importing it from a Client Component fails the build. It never uses
// a service-role/admin client, takes NO tenant_id from the caller as an authorization input,
// and relies entirely on RLS to scope what the signed-in user may read (docs/02).

// Safe DTO for a list view — an explicit column subset, never the whole row.
export type AppSummary = {
  id: string;
  name: string;
  vendorName: string | null;
  category: string | null;
  status: string;
};

// Structured result: callers get typed data or a safe error label, never a raw Supabase error.
export type DataResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "query_failed" };

// Read-only DTO for one app's detail. Owning-org references are exposed as IDs only;
// org-name enrichment is deferred (it needs an embedded join whose visibility differs for
// org-only users — kept out of this first detail page). Linked contracts are shown via a separate
// RLS-backed DAL (src/lib/data/links.ts, org-scoped app_contracts read — 0006), not this DTO.
// App users/invoices/files are intentionally NOT included (tenant-only / default-deny — RISK-002).
export type AppDetail = {
  id: string;
  name: string;
  vendorName: string | null;
  category: string | null;
  status: string;
  // Connector-instance markers (migration 0024) — NON-secret. `externalInstanceId` is the provider workspace id (e.g.
  // the Slack team_id) the resolver set for a synced instance; its presence is how a read-only view identifies a
  // connector-synced app (NOT a token/secret). `instanceUrl` is the workspace URL.
  externalInstanceId: string | null;
  instanceUrl: string | null;
  responsibleOrgId: string | null;
  payingOrgId: string | null;
  procurementOrgId: string | null;
  createdAt: string;
  updatedAt: string;
};

// `not_found` covers both "no such app" and "RLS hid it" — deliberately indistinguishable so the
// route param can't be used to enumerate other tenants' apps.
export type AppDetailResult =
  | { ok: true; data: AppDetail }
  | { ok: false; error: "not_found" | "query_failed" };

// Fetch one app's detail by id. The `appId` is ONLY a lookup key — RLS decides whether the
// signed-in user may read the row; if RLS hides it, this returns `not_found`. No tenant_id from
// the caller, no service-role, no writes.
export async function getAppDetailForCurrentUser(appId: string): Promise<AppDetailResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("apps")
    .select(
      "id, name, vendor_name, category, status, external_instance_id, instance_url, responsible_org_id, paying_org_id, procurement_owner_org_id, created_at, updated_at",
    )
    .eq("id", appId)
    .maybeSingle();

  if (error) {
    console.error("[data/apps] getAppDetailForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }
  if (!data) {
    return { ok: false, error: "not_found" };
  }

  return {
    ok: true,
    data: {
      id: data.id,
      name: data.name,
      vendorName: data.vendor_name,
      category: data.category,
      status: data.status,
      externalInstanceId: data.external_instance_id,
      instanceUrl: data.instance_url,
      responsibleOrgId: data.responsible_org_id,
      payingOrgId: data.paying_org_id,
      procurementOrgId: data.procurement_owner_org_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
  };
}

// Inventory row = the safe AppSummary columns + two RLS-SCOPED counts (linked contracts you may read,
// app users you may read). The counts reflect ONLY rows the signed-in user is allowed to see (RLS on
// app_contracts `0006` / app_users `0007`) — we never show a count of rows the user can't read. They
// are honest "visible to you" tallies, not absolute totals; no person/identity/license/invoice/file data.
export type AppInventoryRow = AppSummary & {
  linkedContractCount: number;
  appUserCount: number;
};

// Tally a flat list of app ids into per-app counts.
function tallyByApp(appIds: readonly (string | null | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of appIds) {
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// List the apps the current user may read, each with its RLS-scoped linked-contract + app-user counts.
// Three RLS-filtered reads (apps, the visible app_contracts app_ids, the visible app_users app_ids),
// tallied in app code — no caller-supplied tenant_id, no service-role, no writes, no embedded joins.
export async function listAppsWithCountsForCurrentUser(): Promise<DataResult<AppInventoryRow[]>> {
  const supabase = await createClient();

  const { data: apps, error: appsErr } = await supabase
    .from("apps")
    .select("id, name, vendor_name, category, status")
    .order("name", { ascending: true });
  if (appsErr) {
    console.error("[data/apps] listAppsWithCountsForCurrentUser apps query failed");
    return { ok: false, error: "query_failed" };
  }

  // Visible link rows (RLS `0006`) + visible app_users (RLS `0007`) — app_id only, tallied per app.
  const { data: links, error: linksErr } = await supabase.from("app_contracts").select("app_id");
  if (linksErr) {
    console.error("[data/apps] listAppsWithCountsForCurrentUser links query failed");
    return { ok: false, error: "query_failed" };
  }
  const { data: users, error: usersErr } = await supabase.from("app_users").select("app_id");
  if (usersErr) {
    console.error("[data/apps] listAppsWithCountsForCurrentUser users query failed");
    return { ok: false, error: "query_failed" };
  }

  const contractCounts = tallyByApp((links ?? []).map((l) => l.app_id));
  const userCounts = tallyByApp((users ?? []).map((u) => u.app_id));

  return {
    ok: true,
    data: (apps ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      vendorName: a.vendor_name,
      category: a.category,
      status: a.status,
      linkedContractCount: contractCounts.get(a.id) ?? 0,
      appUserCount: userCounts.get(a.id) ?? 0,
    })),
  };
}

// List the apps the current user may read. RLS (keyed on the user's tenant/org memberships)
// decides visibility — we pass no tenant filter; the database is the authorization boundary.
export async function listAppsForCurrentUser(): Promise<DataResult<AppSummary[]>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("apps")
    .select("id, name, vendor_name, category, status")
    .order("name", { ascending: true });

  if (error) {
    console.error("[data/apps] listAppsForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: (data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      vendorName: a.vendor_name,
      category: a.category,
      status: a.status,
    })),
  };
}
