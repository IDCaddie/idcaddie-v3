import { describe, it, expect } from "vitest";
import {
  emptyContractForm,
  contractDetailToForm,
  formToWriteInput,
  statusOptionsForValue,
  writeErrorMessage,
  STATUS_OPTIONS,
  type ContractFormValues,
} from "./contract-form-shared";
import type { ContractDetail } from "@/lib/data/contracts";

const detail = (over: Partial<ContractDetail> = {}): ContractDetail => ({
  id: "c-1",
  contractName: "Acme MSA",
  vendorName: null,
  status: "active",
  startDate: null,
  endDate: null,
  renewalDate: null,
  noticeDeadline: null,
  totalCost: null,
  currency: null,
  billingFrequency: null,
  renewalResponsibility: null,
  hasOwner: false,
  procurementOrgId: null,
  payingOrgId: null,
  category: null,
  procurementDate: null,
  notes: null,
  poNumber: null,
  autoRenew: false,
  monthToMonth: false,
  createdAt: "2026-06-16T00:00:00Z",
  updatedAt: "2026-06-16T00:00:00Z",
  ...over,
});

const formValues = (over: Partial<ContractFormValues> = {}): ContractFormValues => ({
  ...emptyContractForm(),
  ...over,
});

describe("emptyContractForm", () => {
  it("defaults to the legacy create defaults (status Draft, currency USD); rest blank", () => {
    const f = emptyContractForm();
    expect(f.status).toBe("Draft");
    expect(f.currency).toBe("USD");
    expect(f.contractName).toBe("");
    expect(f.procurementOrgId).toBe("");
    expect(f.payingOrgId).toBe("");
  });
});

describe("contractDetailToForm", () => {
  it("maps nulls to empty strings and total_cost to its string form", () => {
    const f = contractDetailToForm(
      detail({
        vendorName: "Acme Inc",
        totalCost: 1200.5,
        currency: "USD",
        startDate: "2026-01-01",
        procurementOrgId: "1a1a1a1a-0000-0000-0000-000000000001",
      }),
    );
    expect(f.contractName).toBe("Acme MSA");
    expect(f.vendorName).toBe("Acme Inc");
    expect(f.totalCost).toBe("1200.5");
    expect(f.currency).toBe("USD");
    expect(f.startDate).toBe("2026-01-01");
    expect(f.procurementOrgId).toBe("1a1a1a1a-0000-0000-0000-000000000001");
    // unset nullable fields become ""
    expect(f.endDate).toBe("");
    expect(f.renewalDate).toBe("");
    expect(f.payingOrgId).toBe("");
    expect(f.renewalResponsibility).toBe("");
  });

  it("preserves the contract's existing status verbatim (no silent rewrite)", () => {
    expect(contractDetailToForm(detail({ status: "active" })).status).toBe("active");
  });
});

describe("formToWriteInput", () => {
  it("maps every form field (incl. PR #32 parity fields) to the camelCase write input; no tenant_id/id", () => {
    const values = formValues({
      contractName: "C",
      vendorName: "V",
      status: "Executed",
      category: "Technology",
      totalCost: "999",
      currency: "EUR",
      startDate: "2026-01-01",
      renewalDate: "2026-02-01",
      endDate: "2026-12-31",
      procurementDate: "2026-03-01",
      poNumber: "PO-42",
      renewalResponsibility: "vendor",
      autoRenew: true,
      monthToMonth: false,
      notes: "some notes",
      procurementOrgId: "1a1a1a1a-0000-0000-0000-000000000001",
      payingOrgId: "2b2b2b2b-0000-0000-0000-000000000002",
    });
    const input = formToWriteInput(values);
    expect(input).toEqual({
      contractName: "C",
      vendorName: "V",
      status: "Executed",
      category: "Technology",
      totalCost: "999",
      currency: "EUR",
      startDate: "2026-01-01",
      renewalDate: "2026-02-01",
      endDate: "2026-12-31",
      procurementDate: "2026-03-01",
      poNumber: "PO-42",
      renewalResponsibility: "vendor",
      autoRenew: true,
      monthToMonth: false,
      notes: "some notes",
      procurementOrgId: "1a1a1a1a-0000-0000-0000-000000000001",
      payingOrgId: "2b2b2b2b-0000-0000-0000-000000000002",
    });
    expect(Object.keys(input)).not.toContain("tenant_id");
    expect(Object.keys(input)).not.toContain("id");
  });

  it("booleans round-trip as real booleans (not strings)", () => {
    const on = formToWriteInput(formValues({ autoRenew: true, monthToMonth: true }));
    expect(on.autoRenew).toBe(true);
    expect(on.monthToMonth).toBe(true);
    const off = formToWriteInput(formValues({ autoRenew: false, monthToMonth: false }));
    expect(off.autoRenew).toBe(false);
    expect(off.monthToMonth).toBe(false);
  });
});

describe("PR #32 parity fields round-trip via the form helpers", () => {
  it("emptyContractForm includes the new fields with safe defaults", () => {
    const f = emptyContractForm();
    expect(f.category).toBe("");
    expect(f.procurementDate).toBe("");
    expect(f.poNumber).toBe("");
    expect(f.notes).toBe("");
    expect(f.autoRenew).toBe(false);
    expect(f.monthToMonth).toBe(false);
  });

  it("contractDetailToForm prefills the new fields (nulls→\"\", booleans pass through)", () => {
    const f = contractDetailToForm(
      detail({
        category: "Leases",
        procurementDate: "2026-03-01",
        notes: "n",
        poNumber: "PO-7",
        autoRenew: true,
        monthToMonth: true,
      }),
    );
    expect(f.category).toBe("Leases");
    expect(f.procurementDate).toBe("2026-03-01");
    expect(f.notes).toBe("n");
    expect(f.poNumber).toBe("PO-7");
    expect(f.autoRenew).toBe(true);
    expect(f.monthToMonth).toBe(true);
    // a contract with the new fields unset prefills blank text + false booleans
    const empty = contractDetailToForm(detail());
    expect(empty.category).toBe("");
    expect(empty.notes).toBe("");
    expect(empty.autoRenew).toBe(false);
    expect(empty.monthToMonth).toBe(false);
  });
});

describe("statusOptionsForValue", () => {
  it("returns the legacy option set for a known value", () => {
    expect(statusOptionsForValue("Draft")).toEqual([...STATUS_OPTIONS]);
    expect(statusOptionsForValue("Executed")).toEqual([...STATUS_OPTIONS]);
  });

  it("prepends an unknown current value so editing never silently drops it", () => {
    expect(statusOptionsForValue("active")).toEqual(["active", ...STATUS_OPTIONS]);
  });

  it("an empty current value just yields the base set", () => {
    expect(statusOptionsForValue("")).toEqual([...STATUS_OPTIONS]);
  });
});

describe("writeErrorMessage", () => {
  it("gives a non-empty generic message for every error and never reveals row existence", () => {
    for (const e of ["not_authenticated", "no_tenant", "not_allowed", "invalid_input", "query_failed"] as const) {
      expect(writeErrorMessage(e).length).toBeGreaterThan(0);
    }
    // not_allowed is deliberately indistinguishable from not-found (no enumeration)
    const denied = writeErrorMessage("not_allowed");
    expect(denied).toMatch(/no longer exists/i);
    expect(denied).not.toMatch(/another tenant|forbidden contract exists/i);
  });
});
