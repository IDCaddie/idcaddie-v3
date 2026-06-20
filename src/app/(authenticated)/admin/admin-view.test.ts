import { describe, it, expect } from "vitest";
import { toAdminContextView, ADMIN_NOT_BUILT, IMPLEMENTED_MODULES } from "./admin-view";
import type { ResolvedTenantContext } from "@/lib/auth/tenant-context-derive";

const CTX: ResolvedTenantContext = {
  userId: "00000000-0000-0000-0000-0000000000aa",
  email: "tenant-editor-a@example.test",
  profilePresent: true,
  status: "resolved",
  tenantMembershipCount: 1,
  organizationMembershipCount: 2,
  activeTenant: {
    id: "aaaa1111-1111-1111-1111-111111111111",
    name: "Storage Verifier Tenant A",
    slug: "tenant-a",
    role: "editor",
  },
  tenantMemberships: [],
  organizationMemberships: [
    { organizationId: "org-1", organizationName: "Org One", tenantId: "aaaa1111-1111-1111-1111-111111111111", role: "viewer", belongsToActiveTenant: true },
    { organizationId: "org-2", organizationName: "Org Two", tenantId: "aaaa1111-1111-1111-1111-111111111111", role: "manager", belongsToActiveTenant: true },
  ],
  multipleTenants: false,
  tenantSwitchingRequired: false,
};

describe("toAdminContextView", () => {
  it("projects email + active tenant name/role + org names/roles", () => {
    const v = toAdminContextView(CTX);
    expect(v.email).toBe("tenant-editor-a@example.test");
    expect(v.activeTenantName).toBe("Storage Verifier Tenant A");
    expect(v.role).toBe("editor");
    expect(v.tenantCount).toBe(1);
    expect(v.orgCount).toBe(2);
    expect(v.orgMemberships).toEqual([
      { name: "Org One", role: "viewer" },
      { name: "Org Two", role: "manager" },
    ]);
  });

  it("NEVER exposes a raw tenant/org/user id (no id leaks the resolver's internals)", () => {
    const v = toAdminContextView(CTX);
    const flat = JSON.stringify(v);
    // The raw ids present in the source context must NOT appear anywhere in the projected view.
    expect(flat).not.toContain("aaaa1111-1111-1111-1111-111111111111"); // tenant id
    expect(flat).not.toContain("org-1");
    expect(flat).not.toContain("org-2");
    expect(flat).not.toContain(CTX.userId);
    expect(flat.toLowerCase()).not.toContain("slug");
    // Top-level key set is the safe projection only.
    expect(Object.keys(v).sort()).toEqual(
      ["activeTenantName", "email", "multipleTenants", "orgCount", "orgMemberships", "role", "status", "tenantCount"].sort(),
    );
    // Each org entry carries only name + role.
    for (const o of v.orgMemberships) {
      expect(Object.keys(o).sort()).toEqual(["name", "role"]);
    }
  });

  it("no active tenant → null name/role, not a crash", () => {
    const v = toAdminContextView({ ...CTX, activeTenant: null, status: "no_tenant_membership", tenantMembershipCount: 0 });
    expect(v.activeTenantName).toBeNull();
    expect(v.role).toBeNull();
  });

  it("the Not-built capability list covers every required admin item", () => {
    const labels = ADMIN_NOT_BUILT.map((x) => x.label.toLowerCase());
    for (const needle of [
      "tenant switching",
      "user invitations",
      "role management",
      "sso",
      "scim",
      "connector credential vault",
      "billing",
      "api keys",
      "data retention",
      "security settings",
    ]) {
      expect(labels.some((l) => l.includes(needle))).toBe(true);
    }
    expect(IMPLEMENTED_MODULES.length).toBeGreaterThan(0); // implemented overview is non-empty
  });
});
