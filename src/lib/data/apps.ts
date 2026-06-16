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
      "id, name, vendor_name, category, status, responsible_org_id, paying_org_id, procurement_owner_org_id, created_at, updated_at",
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
      responsibleOrgId: data.responsible_org_id,
      payingOrgId: data.paying_org_id,
      procurementOrgId: data.procurement_owner_org_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
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
