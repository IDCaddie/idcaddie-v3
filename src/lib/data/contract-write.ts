import type { ResolvedTenantContext } from "@/lib/auth/tenant-context-derive";

// Pure, IO-free helpers for the contract write path (create / edit). NO Supabase, NO next/headers,
// NO DB — so it is unit-testable in isolation (contract-write.test.ts), the same split as
// tenant-context-derive.ts (pure) vs tenant-context.ts (IO).
//
// THESE HELPERS DO NOT AUTHORIZE. Postgres RLS (0002/0004) is the only authorization boundary
// (docs/02 §3, docs/13 §2/§4). They only:
//   * shape & validate caller input at the trust boundary (required field, date/uuid/number form),
//   * NEVER read a tenant_id (or id) from caller input — there is no such field; the row's tenant_id
//     is resolved SERVER-SIDE from the actor's context (resolveWriteContextTenantId), and
//   * map a DB error code to a caller-safe label that never reveals cross-tenant row existence.

// UUID / date shape checks — cheap form validation so an obvious typo becomes a clean
// `invalid_input` instead of an opaque DB error. EXISTENCE / tenant-binding of an org id is NOT
// checked here — that is RLS + the enforce_owning_org_tenant trigger's job, mapped to `not_allowed`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// Caller-facing write input. All fields optional; camelCase. There is INTENTIONALLY no `tenantId`/`id`
// field — a caller may never supply the owning tenant (docs/13 §4). `procurementOrgId` is the write
// anchor; `payingOrgId` is a read signal that never grants write (docs/13 §3) but is still a writable
// column of the row, so it is accepted purely as data and left to RLS to authorize.
export type ContractWriteInput = {
  contractName?: string | null;
  vendorName?: string | null;
  status?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  renewalDate?: string | null;
  noticeDeadline?: string | null;
  totalCost?: number | string | null;
  currency?: string | null;
  billingFrequency?: string | null;
  renewalResponsibility?: string | null;
  procurementOrgId?: string | null;
  payingOrgId?: string | null;
  // Legacy-parity fields added in PR #32 (schema-backed by 0011). Text/date are nullable;
  // autoRenew/monthToMonth are NOT NULL boolean flags (default false).
  category?: string | null;
  procurementDate?: string | null;
  notes?: string | null;
  poNumber?: string | null;
  autoRenew?: boolean;
  monthToMonth?: boolean;
};

// Normalized DB column subset (snake_case) — a structural subset of TablesInsert<"contracts"> MINUS
// tenant_id/id. Default-bearing columns (status/currency/renewal_responsibility) are `string` and are
// only ever set when non-empty (so the DB default applies on create / the value is unchanged on
// update); the truly nullable columns are `string | null` (empty input becomes an explicit null).
export type ContractWriteColumns = {
  contract_name?: string;
  vendor_name?: string | null;
  status?: string;
  start_date?: string | null;
  end_date?: string | null;
  renewal_date?: string | null;
  notice_deadline?: string | null;
  total_cost?: number | null;
  currency?: string;
  billing_frequency?: string | null;
  renewal_responsibility?: string;
  procurement_org_id?: string | null;
  paying_org_id?: string | null;
  category?: string | null;
  procurement_date?: string | null;
  notes?: string | null;
  po_number?: string | null;
  auto_renew?: boolean;
  month_to_month?: boolean;
};

export type ContractWriteParse =
  | { ok: true; columns: ContractWriteColumns }
  | { ok: false; issues: string[] };

function trimOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

// Validate + normalize caller input into the exact column set sent to PostgREST.
//
// create: every writable column is considered; nullable columns left empty become null; the three
//   default-bearing columns are omitted when empty so the DB default applies; contract_name is required.
// update (PATCH semantics): a column is touched ONLY if the caller provided its key — so an absent
//   field is left UNCHANGED, while an explicitly-empty nullable field is cleared to null. An update
//   that touches zero columns is rejected (`no fields to update`), and contract_name (NOT NULL) may
//   not be blanked.
export function parseContractWriteInput(
  input: ContractWriteInput,
  opts: { mode: "create" | "update" },
): ContractWriteParse {
  const isCreate = opts.mode === "create";
  const issues: string[] = [];
  const columns: ContractWriteColumns = {};

  // contract_name — required on create; if present on update, must be non-blank (NOT NULL column).
  if (isCreate || input.contractName !== undefined) {
    const name = trimOrNull(input.contractName);
    if (name === null) {
      issues.push(
        isCreate ? "contract_name is required" : "contract_name cannot be empty",
      );
    } else {
      columns.contract_name = name;
    }
  }

  // Nullable text columns — empty becomes null (on create always; on update only when provided).
  if (isCreate || input.vendorName !== undefined) columns.vendor_name = trimOrNull(input.vendorName);
  if (isCreate || input.billingFrequency !== undefined) {
    columns.billing_frequency = trimOrNull(input.billingFrequency);
  }
  if (isCreate || input.category !== undefined) columns.category = trimOrNull(input.category);
  if (isCreate || input.notes !== undefined) columns.notes = trimOrNull(input.notes);
  if (isCreate || input.poNumber !== undefined) columns.po_number = trimOrNull(input.poNumber);

  // Nullable date columns — empty becomes null; a non-empty value must be YYYY-MM-DD.
  const dateFields: ReadonlyArray<[keyof ContractWriteInput, "start_date" | "end_date" | "renewal_date" | "notice_deadline" | "procurement_date"]> = [
    ["startDate", "start_date"],
    ["endDate", "end_date"],
    ["renewalDate", "renewal_date"],
    ["noticeDeadline", "notice_deadline"],
    ["procurementDate", "procurement_date"],
  ];
  for (const [inKey, colKey] of dateFields) {
    if (!isCreate && input[inKey] === undefined) continue;
    const v = trimOrNull(input[inKey]);
    if (v !== null && !DATE_RE.test(v)) {
      issues.push(`${colKey} must be a date (YYYY-MM-DD)`);
      continue;
    }
    columns[colKey] = v;
  }

  // Nullable owning-org columns — empty becomes null; a non-empty value must be a UUID. Whether the
  // org EXISTS / belongs to this tenant is enforced by RLS + the trigger (→ not_allowed), not here.
  if (isCreate || input.procurementOrgId !== undefined) {
    const v = trimOrNull(input.procurementOrgId);
    if (v !== null && !UUID_RE.test(v)) issues.push("procurement_org_id must be a UUID");
    else columns.procurement_org_id = v;
  }
  if (isCreate || input.payingOrgId !== undefined) {
    const v = trimOrNull(input.payingOrgId);
    if (v !== null && !UUID_RE.test(v)) issues.push("paying_org_id must be a UUID");
    else columns.paying_org_id = v;
  }

  // Nullable numeric column — empty becomes null; a provided value must be a finite number.
  if (isCreate || input.totalCost !== undefined) {
    const raw = input.totalCost;
    const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      columns.total_cost = null;
    } else {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) issues.push("total_cost must be a number");
      // numeric(14,2): 12 integer digits max (~1e12). Reject out-of-range here so it is a clean
      // invalid_input instead of an opaque DB 22003 (which would map to query_failed).
      else if (Math.abs(n) >= 1e12) issues.push("total_cost is out of range");
      else columns.total_cost = n;
    }
  }

  // Default-bearing columns — set ONLY when a non-empty value is supplied (so the DB default applies
  // on create, and the value is left unchanged on update). They are never written as null.
  const status = trimOrNull(input.status);
  if (status !== null) columns.status = status;
  const currency = trimOrNull(input.currency);
  if (currency !== null) columns.currency = currency;
  const renewalResponsibility = trimOrNull(input.renewalResponsibility);
  if (renewalResponsibility !== null) columns.renewal_responsibility = renewalResponsibility;

  // Boolean flags (NOT NULL columns). On create always set (the form supplies a real boolean; default
  // false); on update set only when the key is provided (PATCH). Strict `=== true` so any non-true
  // value — including a hostile non-boolean — safely becomes false and the NOT NULL column is never
  // written as null.
  if (isCreate || input.autoRenew !== undefined) columns.auto_renew = input.autoRenew === true;
  if (isCreate || input.monthToMonth !== undefined) columns.month_to_month = input.monthToMonth === true;

  if (issues.length > 0) return { ok: false, issues };
  if (!isCreate && Object.keys(columns).length === 0) {
    return { ok: false, issues: ["no fields to update"] };
  }
  return { ok: true, columns };
}

// The single tenant the actor writes in — resolved SERVER-SIDE, never from caller input (docs/13 §4).
// Tenant member → their active tenant. Org-only steward (no tenant membership) → their org's tenant,
// but ONLY when unambiguous (all org memberships sit in one tenant); ambiguous / none → null (the
// caller cannot pick, and tenant-switching UI is not built). RLS still decides whether the actor may
// actually write a contract in that tenant — this only chooses which tenant_id to stamp on a create.
export function resolveWriteContextTenantId(context: ResolvedTenantContext): string | null {
  if (context.activeTenant) return context.activeTenant.id;
  const tenantIds = Array.from(new Set(context.organizationMemberships.map((o) => o.tenantId)));
  return tenantIds.length === 1 ? tenantIds[0] : null;
}

// Map a PostgREST/Postgres error code to a caller-safe label. Authorization / integrity rejections
// all collapse to `not_allowed` — deliberately indistinguishable from "row not found" so the path
// cannot be used to enumerate other tenants' contracts (docs/13 §8). Any OTHER code is `query_failed`
// (a real, unexpected DB error) — surfaced, never silently swallowed as success.
export function classifyContractWriteError(
  code: string | null | undefined,
): "not_allowed" | "query_failed" {
  switch (code) {
    case "42501": // insufficient_privilege — RLS WITH CHECK / USING denied the write
    case "23514": // check_violation — enforce_owning_org_tenant rejected a cross-tenant owning org
    case "23503": // foreign_key_violation — owning-org / tenant FK absent or cross-tenant
      return "not_allowed";
    default:
      return "query_failed";
  }
}
