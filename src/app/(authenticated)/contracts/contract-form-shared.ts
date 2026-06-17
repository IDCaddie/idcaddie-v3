import type { ContractWriteInput } from "@/lib/data/contract-write";
import type { ContractDetail, ContractWriteResult } from "@/lib/data/contracts";

// Pure, IO-free helpers shared by the contract create/edit form (contract-form.tsx, a Client
// Component) and its unit tests (contract-form-shared.test.ts). NO React, NO Supabase, NO server
// imports — only type-only imports (erased at build), so this file never pulls the server client
// into the client bundle and stays unit-testable in isolation.
//
// These helpers do NOT authorize and do NOT validate authority — RLS (via the PR #30 server actions)
// is the boundary. They only: shape the controlled form state, map it to the PR #30 ContractWriteInput
// (which re-validates everything at the write boundary), and turn a write error into a generic,
// non-enumerating user message.

// Legacy status options, in legacy order (DEFAULT_CONTRACT_FIELDS.status — see docs/15). Create
// defaults to "Draft" (legacy default). v3 `status` is free text; existing rows may hold other
// values (e.g. the v3 column default "active"), so the edit <select> preserves an unknown current
// value rather than silently changing it (statusOptionsForValue).
export const STATUS_OPTIONS = ["Draft", "Executed", "Cancelled", "Expired"] as const;

// The editable fields v3 supports (a subset of the legacy form — docs/15 §4). All strings (controlled
// inputs); the PR #30 parser does the real normalization/validation.
export type ContractFormValues = {
  contractName: string;
  vendorName: string;
  status: string;
  totalCost: string;
  currency: string;
  startDate: string;
  renewalDate: string;
  endDate: string;
  renewalResponsibility: string;
  procurementOrgId: string;
  payingOrgId: string;
};

type ContractWriteError = Extract<ContractWriteResult, { ok: false }>["error"];

// Blank create form. Legacy parity: status default "Draft"; currency default "USD" (legacy implied USD).
export function emptyContractForm(): ContractFormValues {
  return {
    contractName: "",
    vendorName: "",
    status: "Draft",
    totalCost: "",
    currency: "USD",
    startDate: "",
    renewalDate: "",
    endDate: "",
    renewalResponsibility: "",
    procurementOrgId: "",
    payingOrgId: "",
  };
}

// Prefill the edit form from the read DTO. Nulls become "" (empty controlled inputs); the numeric
// total_cost becomes its string form.
export function contractDetailToForm(d: ContractDetail): ContractFormValues {
  return {
    contractName: d.contractName,
    vendorName: d.vendorName ?? "",
    status: d.status,
    totalCost: d.totalCost === null ? "" : String(d.totalCost),
    currency: d.currency ?? "",
    startDate: d.startDate ?? "",
    renewalDate: d.renewalDate ?? "",
    endDate: d.endDate ?? "",
    renewalResponsibility: d.renewalResponsibility ?? "",
    procurementOrgId: d.procurementOrgId ?? "",
    payingOrgId: d.payingOrgId ?? "",
  };
}

// Map controlled form state to the PR #30 write input. Raw strings are passed through unchanged —
// the parser trims, empties→null, and validates. There is intentionally NO tenant_id here (the
// caller may never supply it; it is resolved server-side).
export function formToWriteInput(v: ContractFormValues): ContractWriteInput {
  return {
    contractName: v.contractName,
    vendorName: v.vendorName,
    status: v.status,
    totalCost: v.totalCost,
    currency: v.currency,
    startDate: v.startDate,
    renewalDate: v.renewalDate,
    endDate: v.endDate,
    renewalResponsibility: v.renewalResponsibility,
    procurementOrgId: v.procurementOrgId,
    payingOrgId: v.payingOrgId,
  };
}

// The status options to render: the legacy set, plus the current value if it is not one of them, so
// editing a contract with a legacy/seed status (e.g. "active") never silently rewrites it.
export function statusOptionsForValue(current: string): string[] {
  const base = [...STATUS_OPTIONS] as string[];
  if (current && !base.includes(current)) return [current, ...base];
  return base;
}

// Turn a non-`invalid_input` write error into a generic, user-safe message. `not_allowed` is
// deliberately indistinguishable from "no longer exists" — the UI must never reveal whether a
// forbidden contract exists in another tenant (docs/13 §8).
export function writeErrorMessage(error: ContractWriteError): string {
  switch (error) {
    case "not_authenticated":
      return "Your session has expired. Please sign in again.";
    case "no_tenant":
      return "Your account isn't part of a workspace that can hold contracts, so this couldn't be saved.";
    case "not_allowed":
      return "You don't have permission to save this contract, or it no longer exists.";
    case "invalid_input":
      return "Please fix the highlighted fields and try again.";
    case "query_failed":
    default:
      return "Something went wrong saving the contract. Please try again.";
  }
}
