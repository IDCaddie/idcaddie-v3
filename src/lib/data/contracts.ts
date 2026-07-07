import { createClient } from "@/lib/supabase/server";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import {
  parseContractWriteInput,
  resolveWriteContextTenantId,
  classifyContractWriteError,
  isUuid,
  type ContractWriteInput,
} from "./contract-write";
import type { TablesInsert, TablesUpdate } from "@/lib/database.types";

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
  category: string | null;
  renewalDate: string | null;
  endDate: string | null;
  totalCost: number | null;
  currency: string | null;
  // Ownership as a boolean ONLY — the raw owner_user_id (a profiles FK) never leaves the DAL.
  hasOwner: boolean;
  renewalResponsibility: string | null; // a free-text "who renews this" label (never a user id)
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
  // Ownership as a boolean ONLY — the raw owner_user_id (a profiles FK) never leaves the DAL.
  hasOwner: boolean;
  procurementOrgId: string | null;
  payingOrgId: string | null;
  category: string | null;
  procurementDate: string | null;
  notes: string | null;
  poNumber: string | null;
  autoRenew: boolean;
  monthToMonth: boolean;
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
      "id, contract_name, vendor_name, status, start_date, end_date, renewal_date, notice_deadline, total_cost, currency, billing_frequency, renewal_responsibility, owner_user_id, procurement_org_id, paying_org_id, category, procurement_date, notes, po_number, auto_renew, month_to_month, created_at, updated_at",
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
      hasOwner: data.owner_user_id != null,
      procurementOrgId: data.procurement_org_id,
      payingOrgId: data.paying_org_id,
      category: data.category,
      procurementDate: data.procurement_date,
      notes: data.notes,
      poNumber: data.po_number,
      autoRenew: data.auto_renew,
      monthToMonth: data.month_to_month,
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
    // owner_user_id is read ONLY to compute a hasOwner boolean; it is never returned (no raw profile id).
    .select("id, contract_name, vendor_name, status, category, renewal_date, end_date, total_cost, currency, owner_user_id, renewal_responsibility")
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
      category: c.category,
      renewalDate: c.renewal_date,
      endDate: c.end_date,
      totalCost: c.total_cost,
      currency: c.currency,
      hasOwner: c.owner_user_id != null,
      renewalResponsibility: c.renewal_responsibility,
    })),
  };
}

// ── Contract WRITE path (create / update) — gated entirely by RLS ───────────────────────────────
//
// These are the safe server-side write functions behind the future contract create/edit UI (which
// does NOT exist yet). They use the SAME user-scoped anon server client as the reads — NEVER a
// service-role / admin client — so Postgres RLS (0004: tenant editor+ OR procurement-org manager;
// paying_org never grants write; no DELETE / FOR ALL) is the authorization boundary. The app does no
// authorization itself beyond session/context resolution + input validation (docs/13 §4).
//
// tenant_id is resolved SERVER-SIDE from the actor's context and is NEVER taken from the caller
// (ContractWriteInput has no tenant_id field). An accepted write is audited automatically by the 0010
// AFTER INSERT/UPDATE trigger (contract.created / contract.updated, actor = the caller) — this code
// does NOT (and must not) write audit_logs itself. A denied/failed write is never audited (the
// trigger is AFTER ROW). Errors collapse to a generic "not allowed or not found" so the path cannot
// enumerate other tenants' contracts.

export type ContractWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: "invalid_input"; issues: string[] }
  | { ok: false; error: "not_authenticated" }
  | { ok: false; error: "no_tenant" }
  | { ok: false; error: "not_allowed" }
  | { ok: false; error: "query_failed" };

// Create a contract in the actor's resolved tenant. RLS decides whether the actor (tenant editor+, or
// manager of the supplied procurement_org_id) may insert; the 0010 trigger audits an accepted insert.
export async function createContractForCurrentUser(
  input: ContractWriteInput,
): Promise<ContractWriteResult> {
  const parsed = parseContractWriteInput(input, { mode: "create" });
  if (!parsed.ok) return { ok: false, error: "invalid_input", issues: parsed.issues };

  const context = await resolveTenantContext();
  if (!context) return { ok: false, error: "not_authenticated" };
  // A failed context read returns a truthy errorContext (status='error') — treat it as a retryable
  // server error, not "no tenant" (which would be a misleading permanent label for a transient read).
  if (context.status === "error") return { ok: false, error: "query_failed" };
  const tenantId = resolveWriteContextTenantId(context);
  if (!tenantId) return { ok: false, error: "no_tenant" };

  // parse(create) guarantees contract_name; split it out so the NOT NULL column is a plain string
  // (no non-null assertion). tenant_id comes ONLY from the resolved context above.
  const { contract_name, ...rest } = parsed.columns;
  if (!contract_name) {
    return { ok: false, error: "invalid_input", issues: ["contract_name is required"] };
  }
  const payload: TablesInsert<"contracts"> = { ...rest, contract_name, tenant_id: tenantId };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contracts")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    console.error("[data/contracts] createContractForCurrentUser write rejected");
    return { ok: false, error: classifyContractWriteError(error.code) };
  }
  return { ok: true, id: data.id };
}

// Update an existing contract's own fields (PATCH — only the provided fields change). tenant_id is
// never set here, so the row's tenant is immutable via this path. RLS (USING the existing row +
// WITH CHECK the resulting row) + the trigger decide; an accepted update is audited (contract.updated).
// A row the actor may not update is invisible to the UPDATE (0 rows) → the same generic "not allowed
// or not found" as a non-existent id (no enumeration).
export async function updateContractForCurrentUser(
  contractId: string,
  input: ContractWriteInput,
): Promise<ContractWriteResult> {
  if (typeof contractId !== "string" || !isUuid(contractId)) {
    return { ok: false, error: "invalid_input", issues: ["contractId must be a UUID"] };
  }
  const parsed = parseContractWriteInput(input, { mode: "update" });
  if (!parsed.ok) return { ok: false, error: "invalid_input", issues: parsed.issues };

  const payload: TablesUpdate<"contracts"> = parsed.columns;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contracts")
    .update(payload)
    .eq("id", contractId)
    .select("id");

  if (error) {
    console.error("[data/contracts] updateContractForCurrentUser write rejected");
    return { ok: false, error: classifyContractWriteError(error.code) };
  }
  if (!data || data.length === 0) return { ok: false, error: "not_allowed" };
  return { ok: true, id: data[0].id };
}
