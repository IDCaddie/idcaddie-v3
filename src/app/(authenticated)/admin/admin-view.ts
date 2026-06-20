// Pure (no React / next / "use client") mapper + capability list for the read-only Admin / Settings
// page, so the safe-projection logic is unit-testable. It takes the already-resolved, RLS-scoped
// tenant context (resolveTenantContext → deriveContext) and projects it to a SAFE view that exposes
// ONLY the signed-in email + active tenant NAME/role + org membership NAMES/roles. It DELIBERATELY
// drops every raw id — no tenant_id, no organization_id, no user_id — so the new admin page never
// surfaces a raw tenant/org id (the home/debug page keeps showing the tenant id intentionally; this
// page does not). RLS remains the authority; this code decides no access.

import type { ResolvedTenantContext } from "@/lib/auth/tenant-context-derive";

export type AdminOrgMembership = { name: string; role: string };

export type AdminContextView = {
  email: string | null;
  activeTenantName: string | null;
  role: string | null; // the user's role in the active tenant
  multipleTenants: boolean;
  tenantCount: number;
  orgMemberships: AdminOrgMembership[];
  orgCount: number;
  status: string;
};

export function toAdminContextView(ctx: ResolvedTenantContext): AdminContextView {
  return {
    email: ctx.email,
    activeTenantName: ctx.activeTenant?.name ?? null,
    role: ctx.activeTenant?.role ?? null,
    multipleTenants: ctx.multipleTenants,
    tenantCount: ctx.tenantMembershipCount,
    // Names + roles only — never organizationId / tenantId.
    orgMemberships: ctx.organizationMemberships.map((o) => ({ name: o.organizationName, role: o.role })),
    orgCount: ctx.organizationMembershipCount,
    status: ctx.status,
  };
}

// Read-only "what works today" overview (informational; no data fetch). Kept in sync with the nav.
export const IMPLEMENTED_MODULES: string[] = [
  "Authenticated shell + navigation",
  "Apps inventory + detail (read-only)",
  "Contracts (read + create/edit) + file attachments",
  "People / identity accounts (read-only)",
  "Reports summary (read-only)",
  "Audit / Logs (read-only)",
];

// Old-app Admin/Settings capabilities that are NOT implemented in v3 yet (shown as "Not built yet" so
// the gap is explicit, not hidden). All are out of scope for this read-only page.
export const ADMIN_NOT_BUILT: { label: string; note?: string }[] = [
  { label: "Tenant switching", note: "deferred" },
  { label: "User invitations" },
  { label: "Role management" },
  { label: "SSO / SAML / OIDC" },
  { label: "SCIM / IdP import" },
  { label: "Connector credential vault" },
  { label: "Billing" },
  { label: "API keys / ingestion tokens" },
  { label: "Data retention controls" },
  { label: "Security settings" },
];
