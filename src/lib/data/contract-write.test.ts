import { describe, it, expect } from "vitest";
import {
  parseContractWriteInput,
  resolveWriteContextTenantId,
  classifyContractWriteError,
  isUuid,
  type ContractWriteInput,
} from "./contract-write";
import type { ResolvedTenantContext } from "@/lib/auth/tenant-context-derive";

const OK_UUID = "1a1a1a1a-0000-0000-0000-000000000001";

// parse(create) returns the typed `columns` on success; this unwraps it or fails the test loudly.
function createColumns(input: ContractWriteInput) {
  const r = parseContractWriteInput(input, { mode: "create" });
  if (!r.ok) throw new Error(`expected ok, got issues: ${r.issues.join(", ")}`);
  return r.columns;
}
function updateColumns(input: ContractWriteInput) {
  const r = parseContractWriteInput(input, { mode: "update" });
  if (!r.ok) throw new Error(`expected ok, got issues: ${r.issues.join(", ")}`);
  return r.columns;
}

describe("isUuid", () => {
  it("accepts a well-formed uuid and rejects malformed", () => {
    expect(isUuid(OK_UUID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(`${OK_UUID} `)).toBe(false); // trailing space
  });
});

describe("parseContractWriteInput · create", () => {
  it("minimal valid: only contract_name, defaults omitted (so DB defaults apply)", () => {
    const c = createColumns({ contractName: "Acme MSA" });
    expect(c.contract_name).toBe("Acme MSA");
    // default-bearing columns are NOT present — DB applies status/currency/renewal_responsibility defaults
    expect("status" in c).toBe(false);
    expect("currency" in c).toBe(false);
    expect("renewal_responsibility" in c).toBe(false);
    // never carries a tenant_id
    expect("tenant_id" in c).toBe(false);
  });

  it("requires contract_name (missing, empty, whitespace all fail)", () => {
    for (const input of [{}, { contractName: "" }, { contractName: "   " }, { contractName: null }]) {
      const r = parseContractWriteInput(input, { mode: "create" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues).toContain("contract_name is required");
    }
  });

  it("trims contract_name", () => {
    expect(createColumns({ contractName: "  Acme  " }).contract_name).toBe("Acme");
  });

  it("nullable text/date/uuid/numeric columns: empty input becomes null", () => {
    const c = createColumns({
      contractName: "C",
      vendorName: "",
      billingFrequency: "  ",
      startDate: "",
      endDate: "",
      renewalDate: "",
      noticeDeadline: "",
      procurementOrgId: "",
      payingOrgId: "",
      totalCost: "",
    });
    expect(c.vendor_name).toBeNull();
    expect(c.billing_frequency).toBeNull();
    expect(c.start_date).toBeNull();
    expect(c.end_date).toBeNull();
    expect(c.renewal_date).toBeNull();
    expect(c.notice_deadline).toBeNull();
    expect(c.procurement_org_id).toBeNull();
    expect(c.paying_org_id).toBeNull();
    expect(c.total_cost).toBeNull();
  });

  it("default-bearing columns are set only when non-empty", () => {
    const c = createColumns({
      contractName: "C",
      status: "renewed",
      currency: "eur",
      renewalResponsibility: "vendor",
    });
    expect(c.status).toBe("renewed");
    expect(c.currency).toBe("eur");
    expect(c.renewal_responsibility).toBe("vendor");
  });

  it("accepts valid dates and rejects malformed ones", () => {
    expect(createColumns({ contractName: "C", startDate: "2026-06-16" }).start_date).toBe("2026-06-16");
    const r = parseContractWriteInput({ contractName: "C", endDate: "06/16/2026" }, { mode: "create" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("end_date must be a date (YYYY-MM-DD)");
  });

  it("accepts valid org uuids and rejects malformed ones", () => {
    expect(createColumns({ contractName: "C", procurementOrgId: OK_UUID }).procurement_org_id).toBe(OK_UUID);
    const r = parseContractWriteInput({ contractName: "C", payingOrgId: "abc" }, { mode: "create" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("paying_org_id must be a UUID");
  });

  it("total_cost: number passes through, numeric string parses, non-numeric fails", () => {
    expect(createColumns({ contractName: "C", totalCost: 1200.5 }).total_cost).toBe(1200.5);
    expect(createColumns({ contractName: "C", totalCost: "1200.50" }).total_cost).toBe(1200.5);
    const r = parseContractWriteInput({ contractName: "C", totalCost: "abc" }, { mode: "create" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("total_cost must be a number");
  });

  it("total_cost beyond numeric(14,2) range is invalid_input (not an opaque DB error)", () => {
    // just under the 1e12 cap is fine; at/over is rejected as input, not surfaced as query_failed
    expect(createColumns({ contractName: "C", totalCost: 999999999999.99 }).total_cost).toBe(999999999999.99);
    const r = parseContractWriteInput({ contractName: "C", totalCost: 1e15 }, { mode: "create" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("total_cost is out of range");
  });

  it("never carries caller-supplied tenant_id / id / owner_user_id / audit fields into the columns", () => {
    // Simulate an untyped/overreaching caller passing forbidden keys (identity + audit).
    const hostile = {
      contractName: "C",
      tenant_id: "99999999-9999-9999-9999-999999999999",
      id: "88888888-8888-8888-8888-888888888888",
      owner_user_id: "77777777-7777-7777-7777-777777777777",
      actor_user_id: "66666666-6666-6666-6666-666666666666",
      action: "contract.created",
      created_at: "2000-01-01",
    } as unknown as ContractWriteInput;
    const c = createColumns(hostile);
    for (const forbidden of ["tenant_id", "id", "owner_user_id", "actor_user_id", "action", "created_at"]) {
      expect(Object.keys(c)).not.toContain(forbidden);
    }
    // The output is EXACTLY the writable column set — only keys derived from known input fields.
    expect(c).toEqual({
      contract_name: "C",
      vendor_name: null,
      billing_frequency: null,
      category: null,
      notes: null,
      po_number: null,
      start_date: null,
      end_date: null,
      renewal_date: null,
      notice_deadline: null,
      procurement_date: null,
      procurement_org_id: null,
      paying_org_id: null,
      total_cost: null,
      auto_renew: false,
      month_to_month: false,
    });
  });

  it("aggregates multiple validation issues", () => {
    const r = parseContractWriteInput(
      { contractName: "", startDate: "nope", procurementOrgId: "bad" },
      { mode: "create" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContain("contract_name is required");
      expect(r.issues).toContain("start_date must be a date (YYYY-MM-DD)");
      expect(r.issues).toContain("procurement_org_id must be a UUID");
    }
  });
});

describe("parseContractWriteInput · update (PATCH semantics)", () => {
  it("touches only the fields the caller provided", () => {
    const c = updateColumns({ status: "renewed" });
    expect(c).toEqual({ status: "renewed" });
    expect("contract_name" in c).toBe(false);
    expect("vendor_name" in c).toBe(false);
  });

  it("an empty patch (no fields) is rejected", () => {
    const r = parseContractWriteInput({}, { mode: "update" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("no fields to update");
  });

  it("contract_name may be changed but not blanked (NOT NULL column)", () => {
    expect(updateColumns({ contractName: "New name" }).contract_name).toBe("New name");
    const r = parseContractWriteInput({ contractName: "  " }, { mode: "update" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("contract_name cannot be empty");
  });

  it("an explicitly-provided empty nullable field clears it to null (a real change)", () => {
    const c = updateColumns({ vendorName: "" });
    expect(c).toEqual({ vendor_name: null }); // present + null → an intentional clear, counts as a field
  });

  it("an absent nullable field is left untouched (omitted)", () => {
    const c = updateColumns({ status: "active" });
    expect("vendor_name" in c).toBe(false);
    expect("start_date" in c).toBe(false);
  });

  it("validates provided fields the same way as create", () => {
    const r = parseContractWriteInput({ renewalDate: "2026/01/01" }, { mode: "update" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("renewal_date must be a date (YYYY-MM-DD)");
  });
});

describe("classifyContractWriteError", () => {
  it("maps authorization/integrity codes to not_allowed (no enumeration)", () => {
    expect(classifyContractWriteError("42501")).toBe("not_allowed"); // RLS
    expect(classifyContractWriteError("23514")).toBe("not_allowed"); // check_violation (cross-tenant org trigger)
    expect(classifyContractWriteError("23503")).toBe("not_allowed"); // FK (absent/cross-tenant org)
  });

  it("maps any other / unknown code to query_failed (never swallowed as success)", () => {
    expect(classifyContractWriteError("23502")).toBe("query_failed"); // not_null_violation
    expect(classifyContractWriteError("XX000")).toBe("query_failed");
    expect(classifyContractWriteError(undefined)).toBe("query_failed");
    expect(classifyContractWriteError(null)).toBe("query_failed");
  });
});

describe("resolveWriteContextTenantId", () => {
  const ctx = (over: Partial<ResolvedTenantContext>): ResolvedTenantContext => ({
    userId: "u",
    email: null,
    profilePresent: true,
    status: "resolved",
    tenantMembershipCount: 0,
    organizationMembershipCount: 0,
    activeTenant: null,
    tenantMemberships: [],
    organizationMemberships: [],
    multipleTenants: false,
    tenantSwitchingRequired: false,
    ...over,
  });
  const orgMember = (tenantId: string) => ({
    organizationId: `org-${tenantId}`,
    organizationName: "Org",
    tenantId,
    role: "manager" as const,
    belongsToActiveTenant: false,
  });

  it("a tenant member writes in their active tenant", () => {
    const c = ctx({ activeTenant: { id: "tenant-A", name: "A", slug: "a", role: "editor" } });
    expect(resolveWriteContextTenantId(c)).toBe("tenant-A");
  });

  it("an org-only steward writes in their org's tenant when unambiguous", () => {
    const c = ctx({ organizationMemberships: [orgMember("tenant-A")] });
    expect(resolveWriteContextTenantId(c)).toBe("tenant-A");
  });

  it("org memberships spanning multiple tenants are ambiguous → null", () => {
    const c = ctx({ organizationMemberships: [orgMember("tenant-A"), orgMember("tenant-B")] });
    expect(resolveWriteContextTenantId(c)).toBeNull();
  });

  it("no tenant and no org membership → null", () => {
    expect(resolveWriteContextTenantId(ctx({}))).toBeNull();
  });
});

describe("parseContractWriteInput · PR #32 parity fields (0011)", () => {
  it("create maps the new text/date fields; empty becomes null", () => {
    const c = createColumns({
      contractName: "C",
      category: "Technology",
      procurementDate: "2026-03-01",
      notes: "hello",
      poNumber: "PO-9",
    });
    expect(c.category).toBe("Technology");
    expect(c.procurement_date).toBe("2026-03-01");
    expect(c.notes).toBe("hello");
    expect(c.po_number).toBe("PO-9");
    // empty/blank nullable fields → null
    const blank = createColumns({ contractName: "C", category: "", notes: "  ", poNumber: "", procurementDate: "" });
    expect(blank.category).toBeNull();
    expect(blank.notes).toBeNull();
    expect(blank.po_number).toBeNull();
    expect(blank.procurement_date).toBeNull();
  });

  it("booleans: create always sets them (default false); strict coercion never yields null", () => {
    // not provided → false (NOT NULL columns must always have a value on create)
    const def = createColumns({ contractName: "C" });
    expect(def.auto_renew).toBe(false);
    expect(def.month_to_month).toBe(false);
    // provided true/false pass through
    const on = createColumns({ contractName: "C", autoRenew: true, monthToMonth: true });
    expect(on.auto_renew).toBe(true);
    expect(on.month_to_month).toBe(true);
    // a hostile non-boolean is coerced safely to false (never null, never a string)
    const hostile = createColumns({ contractName: "C", autoRenew: "yes" as unknown as boolean });
    expect(hostile.auto_renew).toBe(false);
  });

  it("invalid procurement_date is rejected like the other dates", () => {
    const r = parseContractWriteInput({ contractName: "C", procurementDate: "03/01/2026" }, { mode: "create" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toContain("procurement_date must be a date (YYYY-MM-DD)");
  });

  it("update (PATCH): only provided new fields are touched; a boolean toggle is a real change", () => {
    // only a boolean provided → only that column is in the patch (a valid, non-empty update)
    const onlyBool = updateColumns({ autoRenew: true });
    expect(onlyBool).toEqual({ auto_renew: true });
    // an absent new field is left untouched
    const onlyNotes = updateColumns({ notes: "x" });
    expect("category" in onlyNotes).toBe(false);
    expect("auto_renew" in onlyNotes).toBe(false);
    expect(onlyNotes.notes).toBe("x");
    // explicitly clearing a nullable new field sets null
    expect(updateColumns({ category: "" })).toEqual({ category: null });
  });
});
