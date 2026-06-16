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
