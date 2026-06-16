import { createClient } from "@/lib/supabase/server";

// Server-only, read-only data access for `contracts`. Same shape as `src/lib/data/apps.ts`.
//
// Boundary: imports the user-scoped server client (which imports next/headers), so it is
// server-only — importing it from a Client Component fails the build. It NEVER uses a
// service-role/admin client, takes NO tenant_id from the caller as authorization, and relies
// entirely on RLS to scope what the signed-in user may read. `contracts` is a core table with
// related-org read access (tenant members + procurement/paying org members — docs/02 §3, §8).
//
// Deliberately NOT here: any query of `app_contracts`, `invoices`, `files`, `license_rules`,
// `license_evaluations`, `identity_accounts`, or `app_user_identity_matches`. Linked apps /
// invoices / files are out of scope while those child/link tables are tenant-only or default-deny
// (RISK-002). This module only ever reads direct columns of `contracts`.

// Safe DTO for the list view — an explicit column subset, never the whole row.
export type ContractSummary = {
  id: string;
  contractName: string;
  vendorName: string | null;
  status: string;
  renewalDate: string | null;
  endDate: string | null;
};

// Structured result: callers get typed data or a safe error label, never a raw Supabase error.
export type DataResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "query_failed" };

// Read-only DTO for one contract's detail — direct `contracts` columns only. Owning-org
// references are exposed as IDs only (org-name enrichment is deferred, as on app detail).
// Linked apps are shown via a separate RLS-backed DAL (src/lib/data/links.ts, org-scoped
// app_contracts read — 0006), not this DTO. Invoices / files are intentionally NOT included
// (default-deny — RISK-002).
export type ContractDetail = {
  id: string;
  contractName: string;
  vendorName: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  renewalDate: string | null;
  noticeDeadline: string | null;
  totalCost: number | null;
  currency: string | null;
  billingFrequency: string | null;
  renewalResponsibility: string | null;
  procurementOrgId: string | null;
  payingOrgId: string | null;
  createdAt: string;
  updatedAt: string;
};

// `not_found` covers both "no such contract" and "RLS hid it" — deliberately indistinguishable so
// the route param can't be used to enumerate other tenants' contracts.
export type ContractDetailResult =
  | { ok: true; data: ContractDetail }
  | { ok: false; error: "not_found" | "query_failed" };

// Fetch one contract's detail by id. `contractId` is ONLY a lookup key — RLS decides whether the
// signed-in user may read the row; if RLS hides it, this returns `not_found`. No tenant_id from
// the caller, no service-role, no writes.
export async function getContractDetailForCurrentUser(
  contractId: string,
): Promise<ContractDetailResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("contracts")
    .select(
      "id, contract_name, vendor_name, status, start_date, end_date, renewal_date, notice_deadline, total_cost, currency, billing_frequency, renewal_responsibility, procurement_org_id, paying_org_id, created_at, updated_at",
    )
    .eq("id", contractId)
    .maybeSingle();

  if (error) {
    console.error("[data/contracts] getContractDetailForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }
  if (!data) {
    return { ok: false, error: "not_found" };
  }

  return {
    ok: true,
    data: {
      id: data.id,
      contractName: data.contract_name,
      vendorName: data.vendor_name,
      status: data.status,
      startDate: data.start_date,
      endDate: data.end_date,
      renewalDate: data.renewal_date,
      noticeDeadline: data.notice_deadline,
      totalCost: data.total_cost,
      currency: data.currency,
      billingFrequency: data.billing_frequency,
      renewalResponsibility: data.renewal_responsibility,
      procurementOrgId: data.procurement_org_id,
      payingOrgId: data.paying_org_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    },
  };
}

// List the contracts the current user may read. RLS (keyed on tenant membership and the
// procurement/paying related-org union) decides visibility — we pass no tenant filter; the
// database is the authorization boundary.
export async function listContractsForCurrentUser(): Promise<DataResult<ContractSummary[]>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("contracts")
    .select("id, contract_name, vendor_name, status, renewal_date, end_date")
    .order("contract_name", { ascending: true });

  if (error) {
    console.error("[data/contracts] listContractsForCurrentUser query failed");
    return { ok: false, error: "query_failed" };
  }

  return {
    ok: true,
    data: (data ?? []).map((c) => ({
      id: c.id,
      contractName: c.contract_name,
      vendorName: c.vendor_name,
      status: c.status,
      renewalDate: c.renewal_date,
      endDate: c.end_date,
    })),
  };
}
