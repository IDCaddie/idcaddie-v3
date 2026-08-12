import { describe, it, expect } from "vitest";
import { parseEntitlementWriteInput, type EntitlementWriteInput } from "./contract-entitlements";

const CONTRACT = "11111111-1111-4111-8111-111111111111";
const CONN = "22222222-2222-4222-8222-222222222222";

const input = (over: Partial<EntitlementWriteInput> = {}): EntitlementWriteInput => ({
  contractId: CONTRACT, sku: "", planName: "", purchasedQuantity: "", minimumQuantity: "", quantityUnit: "",
  unitAmount: "", currency: "", billingFrequency: "", termStart: "", termEnd: "", measuredByConnectionId: "",
  vendorId: "", appProductId: "", appId: "", source: "", confidence: "", evidenceFileId: "", evidenceNote: "",
  ...over,
});

const issues = (i: EntitlementWriteInput): string[] => {
  const r = parseEntitlementWriteInput(i);
  return r.ok ? [] : r.issues;
};
const columns = (i: EntitlementWriteInput) => {
  const r = parseEntitlementWriteInput(i);
  if (!r.ok) throw new Error(`expected a valid parse, got: ${r.issues.join("; ")}`);
  return r.columns;
};

describe("blank means unknown, never zero", () => {
  it("leaves an unfilled quantity as NULL", () => {
    const c = columns(input());
    // This is the single most important line in the file: a blank seat box must not record a purchase of none, because
    // the entire reconciliation distinguishes "not recorded" from "bought zero".
    expect(c.purchased_quantity).toBeNull();
    expect(c.minimum_quantity).toBeNull();
    expect(c.unit_amount).toBeNull();
    expect(c.currency).toBeNull();
    expect(c.term_start).toBeNull();
    expect(c.measured_by_connection_id).toBeNull();
  });

  it("records an explicit zero as zero", () => {
    // "They bought 0" IS a legitimate statement — it just has to be typed, not defaulted.
    expect(columns(input({ purchasedQuantity: "0" })).purchased_quantity).toBe(0);
  });

  it("defaults provenance to the conservative reading, matching the column defaults", () => {
    const c = columns(input());
    expect(c.source).toBe("manual_entry");
    expect(c.confidence).toBe("low");
    expect(c.quantity_unit).toBe("seat");
  });
});

describe("a price must be usable", () => {
  it("refuses a unit price with no currency or no cadence", () => {
    expect(issues(input({ unitAmount: "12.50" }))).toContainEqual(expect.stringContaining("annual footing"));
    expect(issues(input({ unitAmount: "12.50", currency: "USD" }))).toContainEqual(expect.stringContaining("annual footing"));
    expect(issues(input({ unitAmount: "12.50", billingFrequency: "monthly" }))).toContainEqual(expect.stringContaining("annual footing"));
    expect(issues(input({ unitAmount: "12.50", currency: "USD", billingFrequency: "monthly" }))).toEqual([]);
  });

  it("normalizes the currency code and rejects a malformed one", () => {
    expect(columns(input({ unitAmount: "1", currency: "usd", billingFrequency: "annual" })).currency).toBe("USD");
    expect(issues(input({ unitAmount: "1", currency: "dollars", billingFrequency: "annual" }))).toContainEqual(
      expect.stringContaining("three-letter code"),
    );
  });

  it("accepts four decimal places and refuses five, matching numeric(14,4)", () => {
    expect(issues(input({ unitAmount: "12.3456", currency: "USD", billingFrequency: "monthly" }))).toEqual([]);
    expect(issues(input({ unitAmount: "12.34567", currency: "USD", billingFrequency: "monthly" }))).toContainEqual(
      expect.stringContaining("four decimal places"),
    );
  });

  it("refuses a negative price or a fractional quantity", () => {
    expect(issues(input({ unitAmount: "-5", currency: "USD", billingFrequency: "monthly" })).length).toBeGreaterThan(0);
    expect(issues(input({ purchasedQuantity: "10.5" }))).toContainEqual(expect.stringContaining("whole number"));
    expect(issues(input({ purchasedQuantity: "-3" }))).toContainEqual(expect.stringContaining("whole number"));
  });
});

describe("the guards that mirror the database", () => {
  it("refuses a minimum above the purchase", () => {
    expect(issues(input({ purchasedQuantity: "100", minimumQuantity: "200" }))).toContainEqual(
      expect.stringContaining("cannot be greater than"),
    );
    expect(issues(input({ purchasedQuantity: "200", minimumQuantity: "200" }))).toEqual([]);
  });

  it("refuses a reversed term and a malformed date", () => {
    expect(issues(input({ termStart: "2026-06-01", termEnd: "2026-01-01" }))).toContainEqual(
      expect.stringContaining("cannot end before"),
    );
    expect(issues(input({ termStart: "01/06/2026" }))).toContainEqual(expect.stringContaining("YYYY-MM-DD"));
  });

  it("refuses values outside the bounded vocabularies", () => {
    expect(issues(input({ quantityUnit: "gigabytes" })).length).toBe(1);
    expect(issues(input({ billingFrequency: "fortnightly" })).length).toBe(1);
    expect(issues(input({ source: "a_guess" })).length).toBe(1);
    expect(issues(input({ confidence: "certain" })).length).toBe(1);
  });

  it("requires a contract and refuses a non-UUID reference", () => {
    expect(issues(input({ contractId: "" }))).toContainEqual(expect.stringContaining("contract is required"));
    expect(issues(input({ measuredByConnectionId: "slack" }))).toContainEqual(expect.stringContaining("Measurement source"));
  });

  it("never accepts a tenant_id from the caller", () => {
    // tenant_id is resolved server-side; it must not be reachable through the parsed column set.
    expect(columns(input())).not.toHaveProperty("tenant_id");
  });
});

describe("a fully described line", () => {
  it("maps every field to its column", () => {
    const c = columns(
      input({
        sku: " SLACK-BUSINESS-PLUS ", planName: "Business+", purchasedQuantity: "3200", minimumQuantity: "3000",
        quantityUnit: "seat", unitAmount: "12.50", currency: "USD", billingFrequency: "monthly",
        termStart: "2026-01-01", termEnd: "2026-12-31", measuredByConnectionId: CONN,
        source: "order_form", confidence: "high", evidenceNote: " order form p.3 ",
      }),
    );
    expect(c).toMatchObject({
      contract_id: CONTRACT, sku: "SLACK-BUSINESS-PLUS", plan_name: "Business+",
      purchased_quantity: 3200, minimum_quantity: 3000, quantity_unit: "seat",
      unit_amount: 12.5, currency: "USD", billing_frequency: "monthly",
      term_start: "2026-01-01", term_end: "2026-12-31", measured_by_connection_id: CONN,
      source: "order_form", confidence: "high", evidence_note: "order form p.3",
    });
  });
});
