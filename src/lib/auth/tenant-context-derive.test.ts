import { describe, it, expect } from "vitest";
import { deriveContext, type TenantMembershipSummary } from "./tenant-context-derive";

const tm = (
  tenantId: string,
  tenantName: string,
  role: TenantMembershipSummary["role"] = "viewer",
): TenantMembershipSummary => ({
  tenantId,
  tenantName,
  tenantSlug: tenantName.toLowerCase(),
  role,
  membershipStatus: "active",
});

const base = { userId: "u1", email: "u@example.com", profilePresent: true };

describe("deriveContext", () => {
  it("no memberships at all → no_membership, null active tenant", () => {
    const c = deriveContext({ ...base, tenantMemberships: [], organizationMembershipsRaw: [] });
    expect(c.status).toBe("no_membership");
    expect(c.activeTenant).toBeNull();
    expect(c.tenantSwitchingRequired).toBe(false);
  });

  it("org-only (no tenant membership) → no_tenant_membership, null active tenant, org listed", () => {
    const c = deriveContext({
      ...base,
      tenantMemberships: [],
      organizationMembershipsRaw: [
        { organizationId: "o1", organizationName: "Agency A", tenantId: "t9", role: "viewer" },
      ],
    });
    expect(c.status).toBe("no_tenant_membership");
    expect(c.activeTenant).toBeNull();
    expect(c.organizationMembershipCount).toBe(1);
    expect(c.organizationMemberships[0].belongsToActiveTenant).toBe(false);
  });

  it("single tenant membership → resolved, that tenant active", () => {
    const c = deriveContext({
      ...base,
      tenantMemberships: [tm("t1", "Acme", "admin")],
      organizationMembershipsRaw: [],
    });
    expect(c.status).toBe("resolved");
    expect(c.activeTenant).toEqual({ id: "t1", name: "Acme", slug: "acme", role: "admin" });
    expect(c.multipleTenants).toBe(false);
  });

  it("multiple tenants → deterministic first by name, switching required", () => {
    const c = deriveContext({
      ...base,
      tenantMemberships: [tm("t2", "Zeta"), tm("t1", "Alpha")],
      organizationMembershipsRaw: [],
    });
    expect(c.activeTenant?.name).toBe("Alpha"); // sorted by name regardless of input order
    expect(c.multipleTenants).toBe(true);
    expect(c.tenantSwitchingRequired).toBe(true);
  });

  it("org belongsToActiveTenant is true only for the active tenant", () => {
    const c = deriveContext({
      ...base,
      tenantMemberships: [tm("t1", "Acme")],
      organizationMembershipsRaw: [
        { organizationId: "o1", organizationName: "In", tenantId: "t1", role: "manager" },
        { organizationId: "o2", organizationName: "Out", tenantId: "t2", role: "viewer" },
      ],
    });
    const byId = Object.fromEntries(c.organizationMemberships.map((o) => [o.organizationId, o]));
    expect(byId["o1"].belongsToActiveTenant).toBe(true);
    expect(byId["o2"].belongsToActiveTenant).toBe(false);
  });
});
