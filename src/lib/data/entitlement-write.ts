import type { TablesInsert } from "@/lib/database.types";

// Pure, IO-free input contract for the purchased-line write path. NO Supabase, NO next/headers, NO DB — the same split as
// contract-write.ts (pure) vs contracts.ts (IO), and for the same two reasons: it stays unit-testable in isolation, and the
// client form can import the vocabularies and the parser WITHOUT dragging the server Supabase client into the browser bundle.
// (The type-only import above is erased at build.)
//
// THESE HELPERS DO NOT AUTHORIZE. 0083's RLS is the only authorization boundary. They shape and validate caller input, and
// there is deliberately no tenant_id field — the row's tenant is resolved server-side from the actor's context.

export type EntitlementWriteInput = {
  contractId: string;
  sku: string;
  planName: string;
  purchasedQuantity: string;
  minimumQuantity: string;
  quantityUnit: string;
  unitAmount: string;
  currency: string;
  billingFrequency: string;
  termStart: string;
  termEnd: string;
  measuredByConnectionId: string;
  vendorId: string;
  appProductId: string;
  appId: string;
  source: string;
  confidence: string;
  evidenceFileId: string;
  evidenceNote: string;
};

export const QUANTITY_UNITS = ["seat", "license", "user", "credit", "unit"] as const;
export const BILLING_FREQUENCIES = ["monthly", "quarterly", "annual", "multi_year", "one_time"] as const;
export const ENTITLEMENT_SOURCES = ["contract_document", "order_form", "invoice", "vendor_portal", "manual_entry"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);

const trimmed = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export type ParsedEntitlement =
  | { ok: true; columns: Omit<TablesInsert<"contract_entitlements">, "tenant_id"> }
  | { ok: false; issues: string[] };

// Parse + normalize. Empty string means "unset" and becomes NULL — never 0, which is the whole point of 0083's nullable
// quantities: a blank seat box must not record a purchase of none.
export function parseEntitlementWriteInput(input: EntitlementWriteInput): ParsedEntitlement {
  const issues: string[] = [];

  const contractId = trimmed(input.contractId);
  if (contractId === null || !isUuid(contractId)) issues.push("A contract is required.");

  const int = (raw: string, label: string): number | null => {
    const t = trimmed(raw);
    if (t === null) return null;
    if (!/^\d+$/.test(t)) {
      issues.push(`${label} must be a whole number of units, or left blank if it is not known.`);
      return null;
    }
    return Number(t);
  };
  const purchasedQuantity = int(input.purchasedQuantity, "Purchased quantity");
  const minimumQuantity = int(input.minimumQuantity, "Minimum quantity");
  if (purchasedQuantity !== null && minimumQuantity !== null && minimumQuantity > purchasedQuantity) {
    issues.push("The contracted minimum cannot be greater than the purchased quantity.");
  }

  let unitAmount: number | null = null;
  const rawAmount = trimmed(input.unitAmount);
  if (rawAmount !== null) {
    if (!/^\d+(\.\d{1,4})?$/.test(rawAmount)) {
      issues.push("Unit price must be a positive amount with at most four decimal places.");
    } else {
      unitAmount = Number(rawAmount);
    }
  }

  const currency = trimmed(input.currency)?.toUpperCase() ?? null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) issues.push("Currency must be a three-letter code, for example USD.");

  const billingFrequency = trimmed(input.billingFrequency);
  if (billingFrequency !== null && !BILLING_FREQUENCIES.includes(billingFrequency as (typeof BILLING_FREQUENCIES)[number])) {
    issues.push("Billing frequency is not one of the supported values.");
  }
  // The same rule 0083 enforces, surfaced as a field message rather than a constraint violation: a price that cannot be
  // annualized is not a usable price.
  if (unitAmount !== null && (currency === null || billingFrequency === null)) {
    issues.push("A unit price needs both a currency and a billing frequency, otherwise it cannot be put on an annual footing.");
  }

  const quantityUnit = trimmed(input.quantityUnit) ?? "seat";
  if (!QUANTITY_UNITS.includes(quantityUnit as (typeof QUANTITY_UNITS)[number])) issues.push("Quantity unit is not one of the supported values.");

  const source = trimmed(input.source) ?? "manual_entry";
  if (!ENTITLEMENT_SOURCES.includes(source as (typeof ENTITLEMENT_SOURCES)[number])) issues.push("Provenance source is not one of the supported values.");

  const confidence = trimmed(input.confidence) ?? "low";
  if (!CONFIDENCE_LEVELS.includes(confidence as (typeof CONFIDENCE_LEVELS)[number])) issues.push("Confidence is not one of the supported values.");

  const date = (raw: string, label: string): string | null => {
    const t = trimmed(raw);
    if (t === null) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      issues.push(`${label} must be a date in YYYY-MM-DD form.`);
      return null;
    }
    return t;
  };
  const termStart = date(input.termStart, "Term start");
  const termEnd = date(input.termEnd, "Term end");
  if (termStart !== null && termEnd !== null && termEnd < termStart) issues.push("The term cannot end before it starts.");

  const optionalId = (raw: string, label: string): string | null => {
    const t = trimmed(raw);
    if (t === null) return null;
    if (!isUuid(t)) {
      issues.push(`${label} is not a valid reference.`);
      return null;
    }
    return t;
  };
  const measuredByConnectionId = optionalId(input.measuredByConnectionId, "Measurement source");
  const vendorId = optionalId(input.vendorId, "Vendor");
  const appProductId = optionalId(input.appProductId, "Product");
  const appId = optionalId(input.appId, "Application");
  const evidenceFileId = optionalId(input.evidenceFileId, "Evidence document");

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    columns: {
      contract_id: contractId as string,
      sku: trimmed(input.sku),
      plan_name: trimmed(input.planName),
      purchased_quantity: purchasedQuantity,
      minimum_quantity: minimumQuantity,
      quantity_unit: quantityUnit,
      unit_amount: unitAmount,
      currency,
      billing_frequency: billingFrequency,
      term_start: termStart,
      term_end: termEnd,
      measured_by_connection_id: measuredByConnectionId,
      vendor_id: vendorId,
      app_product_id: appProductId,
      app_id: appId,
      source,
      confidence,
      evidence_file_id: evidenceFileId,
      evidence_note: trimmed(input.evidenceNote),
    },
  };
}
