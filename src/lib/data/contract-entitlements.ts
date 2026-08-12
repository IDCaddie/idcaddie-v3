import { createClient } from "@/lib/supabase/server";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
// Tenant resolution is the CONTRACT path's, reused verbatim: an entitlement belongs to a contract, so it must land in the
// same tenant the contract write path would have chosen, by the same rule (active tenant, else a single unambiguous org tenant).
import { resolveWriteContextTenantId } from "./contract-write";
import type { TablesInsert, TablesUpdate } from "@/lib/database.types";
import type { EntitlementInput } from "@/lib/server/commercial-analytics/reconcile";

// Server-only, RLS-scoped data access for `contract_entitlements` (0083). Same shape and same boundary as
// src/lib/data/contracts.ts: it imports the USER-scoped server client, never a service-role/admin client, takes NO
// tenant_id from the caller as authorization, and relies entirely on Postgres RLS to decide what is visible and
// writable. 0083's policies do that by deriving from the parent contract, so this module adds no authorization of its
// own beyond session/context resolution and input validation.
//
// An accepted write is audited by the 0083 AFTER trigger (contract_entitlement.created / .updated, actor = the caller).
// This code does NOT and must not write audit_logs itself.

// The columns every read selects. ONE unbroken literal, not a concatenation: supabase-js infers the row type by parsing this
// string at the type level, and a `+` join degrades it to `string` and takes the inference with it.
const COLUMNS =
  "id, contract_id, vendor_id, app_product_id, app_id, sku, plan_name, purchased_quantity, minimum_quantity, quantity_unit, unit_amount, currency, billing_frequency, term_start, term_end, measured_by_connection_id, source, confidence, evidence_file_id, evidence_note, created_at, updated_at";

// The read DTO IS the engine's input shape plus the display-only fields, so nothing has to map between two nearly
// identical records. `evidence_file_id` never leaves as a raw id — it becomes a boolean, matching how `owner_user_id`
// is exposed as `hasOwner` on contracts.
export type ContractEntitlement = EntitlementInput & {
  readonly evidenceNote: string | null;
  readonly updatedAt: string;
};

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: "query_failed" };

type Row = {
  id: string; contract_id: string; vendor_id: string | null; app_product_id: string | null; app_id: string | null;
  sku: string | null; plan_name: string | null; purchased_quantity: number | null; minimum_quantity: number | null;
  quantity_unit: string; unit_amount: number | null; currency: string | null; billing_frequency: string | null;
  term_start: string | null; term_end: string | null; measured_by_connection_id: string | null;
  source: string; confidence: string; evidence_file_id: string | null; evidence_note: string | null; updated_at: string;
};

const toDto = (r: Row): ContractEntitlement => ({
  id: r.id,
  contractId: r.contract_id,
  vendorId: r.vendor_id,
  appProductId: r.app_product_id,
  sku: r.sku,
  planName: r.plan_name,
  purchasedQuantity: r.purchased_quantity,
  minimumQuantity: r.minimum_quantity,
  quantityUnit: r.quantity_unit,
  unitAmount: r.unit_amount,
  currency: r.currency,
  billingFrequency: r.billing_frequency,
  termStart: r.term_start,
  termEnd: r.term_end,
  measuredByConnectionId: r.measured_by_connection_id,
  source: r.source,
  // The CHECK constraint bounds this to three values; the cast records that the database, not this file, is the guard.
  confidence: r.confidence as "high" | "medium" | "low",
  hasEvidenceDocument: r.evidence_file_id !== null,
  evidenceNote: r.evidence_note,
  updatedAt: r.updated_at,
});

// The lines of one contract. `contractId` is ONLY a lookup key — RLS decides visibility, so an id belonging to another
// tenant returns an empty list exactly as a non-existent one does (no enumeration).
export async function listEntitlementsForContract(contractId: string): Promise<DataResult<ContractEntitlement[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contract_entitlements")
    .select(COLUMNS)
    .eq("contract_id", contractId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[data/contract-entitlements] listEntitlementsForContract query failed");
    return { ok: false, error: "query_failed" };
  }
  return { ok: true, data: (data ?? []).map((r) => toDto(r)) };
}

// Every line the caller may read, for the portfolio-level findings (duplicates, unmeasured sources). No tenant filter is
// passed — the database is the authorization boundary.
export async function listEntitlementsForCurrentUser(): Promise<DataResult<ContractEntitlement[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contract_entitlements")
    .select(COLUMNS)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[data/contract-entitlements] listEntitlementsForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }
  return { ok: true, data: (data ?? []).map((r) => toDto(r)) };
}

// ── WRITE ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The parser below is the app-side input contract. It does NOT authorize — 0083's RLS does — but it does refuse the
// shapes the database would reject anyway, so a user gets a field-level message instead of a constraint error, and it
// refuses a few the database cannot see (a price with no cadence reaching the DB as three separate nulls, say).

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

export type EntitlementWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: "invalid_input"; issues: string[] }
  | { ok: false; error: "not_authenticated" }
  | { ok: false; error: "no_tenant" }
  | { ok: false; error: "not_allowed" }
  | { ok: false; error: "query_failed" };

// Postgres codes we can safely distinguish. 42501 is an RLS refusal; 23503/23514 are the same-tenant FK and the CHECK
// guards, which a caller reaching this point has already been told about — they collapse to the generic message so the
// path cannot be used to probe another tenant's rows.
const classify = (code: string | undefined): "not_allowed" | "query_failed" =>
  code === "42501" || code === "23503" || code === "23514" ? "not_allowed" : "query_failed";

export async function createEntitlementForCurrentUser(input: EntitlementWriteInput): Promise<EntitlementWriteResult> {
  const parsed = parseEntitlementWriteInput(input);
  if (!parsed.ok) return { ok: false, error: "invalid_input", issues: parsed.issues };

  const context = await resolveTenantContext();
  if (!context) return { ok: false, error: "not_authenticated" };
  if (context.status === "error") return { ok: false, error: "query_failed" };
  const tenantId = resolveWriteContextTenantId(context);
  if (!tenantId) return { ok: false, error: "no_tenant" };

  const payload: TablesInsert<"contract_entitlements"> = { ...parsed.columns, tenant_id: tenantId };
  const supabase = await createClient();
  const { data, error } = await supabase.from("contract_entitlements").insert(payload).select("id").single();

  if (error) {
    console.error("[data/contract-entitlements] createEntitlementForCurrentUser write rejected");
    return { ok: false, error: classify(error.code) };
  }
  return { ok: true, id: data.id };
}

// PATCH semantics, matching updateContractForCurrentUser: tenant_id is never set here, so the row's tenant is immutable
// through this path, and a row the actor may not update is invisible to the UPDATE (0 rows) → the same generic
// "not allowed or no longer exists" as a non-existent id.
export async function updateEntitlementForCurrentUser(
  entitlementId: string,
  input: EntitlementWriteInput,
): Promise<EntitlementWriteResult> {
  if (!isUuid(entitlementId)) return { ok: false, error: "invalid_input", issues: ["entitlementId must be a UUID"] };
  const parsed = parseEntitlementWriteInput(input);
  if (!parsed.ok) return { ok: false, error: "invalid_input", issues: parsed.issues };

  // `updated_at` is maintained here rather than by a trigger, matching the `contracts` convention (0083's closing note).
  const payload: TablesUpdate<"contract_entitlements"> = { ...parsed.columns, updated_at: new Date().toISOString() };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contract_entitlements")
    .update(payload)
    .eq("id", entitlementId)
    .select("id");

  if (error) {
    console.error("[data/contract-entitlements] updateEntitlementForCurrentUser write rejected");
    return { ok: false, error: classify(error.code) };
  }
  if (!data || data.length === 0) return { ok: false, error: "not_allowed" };
  return { ok: true, id: data[0].id };
}
