import { createClient } from "@/lib/supabase/server";

// Server-only, read-only data access for `organizations` — a minimal id+name list used to populate
// the contract form's procurement/paying org <select>s (PR #31). Same boundary as the other read
// DALs: imports the user-scoped server client (NEVER a service-role/admin client), takes NO tenant_id
// from the caller, and relies entirely on RLS to scope visibility.
//
// RLS already governs this exactly (0001 "members read organizations" = is_tenant_member(tenant_id);
// 0002 "org members read their org" = is_org_member(id)): a tenant member sees only their tenant's
// orgs; an org-only user sees only their own org(s). There is NO broadening here and NO cross-tenant
// read — we add no policy and pass no filter. Selecting the org for a contract is then a pick from the
// caller's own RLS-visible set; the contract write itself is still authorized by RLS + the
// enforce_owning_org_tenant trigger (a foreign-tenant org is rejected at write time).

export type OrgOption = { id: string; name: string };

export type OrgListResult =
  | { ok: true; data: OrgOption[] }
  | { ok: false; error: "query_failed" };

// List the organizations the current user may read (id + name only). No tenant filter, no
// service-role, no writes — the database decides what is visible.
export async function listOrganizationsForCurrentUser(): Promise<OrgListResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) {
    console.error("[data/organizations] listOrganizationsForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }

  return { ok: true, data: (data ?? []).map((o) => ({ id: o.id, name: o.name })) };
}
