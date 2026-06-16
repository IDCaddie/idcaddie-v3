import { getSessionUser } from "./session";
import { createClient } from "@/lib/supabase/server";
import {
  deriveContext,
  type OrganizationMembershipSummary,
  type OrgRole,
  type ResolvedTenantContext,
  type TenantMembershipSummary,
  type TenantRole,
} from "./tenant-context-derive";

// Tenant/org context resolution (build-sequence Stage 3). Pure derivation lives in
// tenant-context-derive.ts; this module does the IO and re-exports the types.
//
// Read-only. Uses ONLY the user-scoped server Supabase client, so every read is governed by
// the existing Postgres RLS policies — RLS is the authority, this code never decides access.
// It does NOT, and must NOT:
//   - use a service-role / admin client or bypass RLS,
//   - read all tenants/orgs and filter client-side,
//   - trust JWT custom claims for roles,
//   - cache tenant/org/role state in the browser or browser storage,
//   - create tenants, users, orgs, or memberships.
//
// Only `status='active'` memberships resolve: `is_tenant_member` filters on active status, so
// RLS hides invited/disabled rows — an invited-but-inactive user reads as no_tenant_membership.
//
// Org hierarchy: `organizations.parent_org_id` exists but parent→child inheritance is NOT
// enforced by schema/RLS and is NOT applied here (deferred — see docs/04 RISK-004).
export * from "./tenant-context-derive";

// PostgREST returns a to-one embedded row as an object, but supabase-js (untyped client) widens
// it to an array. Normalize to the single row (or null), correct for both shapes.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// Safe structured error context — never carries raw Supabase error details.
function errorContext(userId: string, email: string | null): ResolvedTenantContext {
  return {
    userId,
    email,
    profilePresent: false,
    status: "error",
    tenantMembershipCount: 0,
    organizationMembershipCount: 0,
    activeTenant: null,
    tenantMemberships: [],
    organizationMemberships: [],
    multipleTenants: false,
    tenantSwitchingRequired: false,
  };
}

// Resolve the signed-in user's tenant/org context, or null if unauthenticated.
export async function resolveTenantContext(): Promise<ResolvedTenantContext | null> {
  const user = await getSessionUser();
  if (!user) return null;

  const supabase = await createClient();

  // Profile (own row only, via RLS `id = auth.uid()`).
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    console.error("[tenant-context] profile read failed");
    return errorContext(user.id, user.email ?? null);
  }

  // Tenant memberships (own active rows; RLS already restricts to active-membership tenants).
  const { data: tmRows, error: tmError } = await supabase
    .from("tenant_memberships")
    .select("role, status, tenant:tenants(id, name, slug)")
    .eq("user_id", user.id)
    .eq("status", "active");
  if (tmError) {
    console.error("[tenant-context] tenant_memberships read failed");
    return errorContext(user.id, user.email ?? null);
  }

  // Org memberships (own rows, via RLS `user_id = auth.uid()`).
  const { data: omRows, error: omError } = await supabase
    .from("organization_memberships")
    .select("role, organization:organizations(id, name, tenant_id)")
    .eq("user_id", user.id);
  if (omError) {
    console.error("[tenant-context] organization_memberships read failed");
    return errorContext(user.id, user.email ?? null);
  }

  const tenantMemberships: TenantMembershipSummary[] = (tmRows ?? []).flatMap((r) => {
    const t = one(r.tenant);
    if (!t) return [];
    return [
      {
        tenantId: t.id as string,
        tenantName: t.name as string,
        tenantSlug: t.slug as string,
        role: r.role as TenantRole,
        membershipStatus: r.status as string,
      },
    ];
  });

  const organizationMembershipsRaw: Omit<
    OrganizationMembershipSummary,
    "belongsToActiveTenant"
  >[] = (omRows ?? []).flatMap((r) => {
    const o = one(r.organization);
    if (!o) return [];
    return [
      {
        organizationId: o.id as string,
        organizationName: o.name as string,
        tenantId: o.tenant_id as string,
        role: r.role as OrgRole,
      },
    ];
  });

  return deriveContext({
    userId: user.id,
    email: profile?.email ?? user.email ?? null,
    profilePresent: profile != null,
    tenantMemberships,
    organizationMembershipsRaw,
  });
}
