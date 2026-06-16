// Pure tenant/org context derivation — NO IO, no server imports, so it is unit-testable in
// isolation (tenant-context-derive.test.ts). The async resolver in tenant-context.ts does the
// RLS-governed Supabase reads, then calls deriveContext here. Keep this file dependency-free.

export type TenantRole = "owner" | "admin" | "editor" | "viewer";
export type OrgRole = "manager" | "viewer";

export type TenantMembershipSummary = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: TenantRole;
  membershipStatus: string;
};

export type OrganizationMembershipSummary = {
  organizationId: string;
  organizationName: string;
  tenantId: string;
  role: OrgRole;
  belongsToActiveTenant: boolean;
};

export type ActiveTenantSummary = {
  id: string;
  name: string;
  slug: string;
  role: TenantRole;
};

export type ContextStatus =
  | "resolved" // ≥1 active tenant membership; activeTenant set
  | "no_tenant_membership" // 0 tenant memberships, but ≥1 org membership (org-only access)
  | "no_membership" // 0 tenant AND 0 org memberships
  | "error"; // a read failed; details are NOT surfaced to the user

export type ResolvedTenantContext = {
  userId: string;
  email: string | null;
  profilePresent: boolean;
  status: ContextStatus;
  tenantMembershipCount: number;
  organizationMembershipCount: number;
  activeTenant: ActiveTenantSummary | null;
  tenantMemberships: TenantMembershipSummary[];
  organizationMemberships: OrganizationMembershipSummary[];
  multipleTenants: boolean;
  tenantSwitchingRequired: boolean;
};

export type DeriveInput = {
  userId: string;
  email: string | null;
  profilePresent: boolean;
  tenantMemberships: TenantMembershipSummary[];
  organizationMembershipsRaw: Omit<OrganizationMembershipSummary, "belongsToActiveTenant">[];
};

// Active-tenant rule:
//   0 tenant memberships  → activeTenant null
//   1 tenant membership   → that tenant
//   >1 tenant memberships → deterministic first (by name, then id); tenantSwitchingRequired=true
// Tenant switching UI is NOT built (deferred); this only picks a stable default.
export function deriveContext(input: DeriveInput): ResolvedTenantContext {
  const tenantMemberships = [...input.tenantMemberships].sort(
    (a, b) =>
      a.tenantName.localeCompare(b.tenantName) || a.tenantId.localeCompare(b.tenantId),
  );

  const first = tenantMemberships[0] ?? null;
  const activeTenant: ActiveTenantSummary | null = first
    ? { id: first.tenantId, name: first.tenantName, slug: first.tenantSlug, role: first.role }
    : null;

  const organizationMemberships: OrganizationMembershipSummary[] =
    input.organizationMembershipsRaw.map((o) => ({
      ...o,
      belongsToActiveTenant: activeTenant != null && o.tenantId === activeTenant.id,
    }));

  const tenantMembershipCount = tenantMemberships.length;
  const organizationMembershipCount = organizationMemberships.length;

  let status: ContextStatus;
  if (tenantMembershipCount > 0) status = "resolved";
  else if (organizationMembershipCount > 0) status = "no_tenant_membership";
  else status = "no_membership";

  return {
    userId: input.userId,
    email: input.email,
    profilePresent: input.profilePresent,
    status,
    tenantMembershipCount,
    organizationMembershipCount,
    activeTenant,
    tenantMemberships,
    organizationMemberships,
    multipleTenants: tenantMembershipCount > 1,
    tenantSwitchingRequired: tenantMembershipCount > 1,
  };
}
