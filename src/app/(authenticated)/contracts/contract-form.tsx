"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createContractAction, updateContractAction } from "./actions";
import type { OrgOption } from "@/lib/data/organizations";
import {
  type ContractFormValues,
  formToWriteInput,
  statusOptionsForValue,
  writeErrorMessage,
} from "./contract-form-shared";

// Contract create/edit form (the first user-visible contract WRITE surface — PR #31). A Client
// Component for controlled inputs (mirrors the legacy form's interactivity — docs/15), but it holds
// NO authorization logic: it posts to the PR #30 server actions, and Postgres RLS decides whether the
// save is allowed. The affordance may be shown to any viewer for usability; a denied save returns a
// generic "not allowed or no longer exists" (no enumeration). On success it redirects to the contract
// detail page. tenant_id is never sent (resolved server-side); accepted saves are audited by 0010.

const inputClass =
  "w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label} {required ? <span className="text-red-600">*</span> : null}
      </label>
      {children}
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function ContractForm({
  mode,
  contractId,
  initial,
  orgs,
}: {
  mode: "create" | "edit";
  contractId?: string;
  initial: ContractFormValues;
  orgs: OrgOption[];
}) {
  const router = useRouter();
  const [values, setValues] = useState<ContractFormValues>(initial);
  const [issues, setIssues] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cancelHref = mode === "edit" && contractId ? `/contracts/${contractId}` : "/contracts";
  const set = (key: keyof ContractFormValues) => (e: { target: { value: string } }) =>
    setValues((p) => ({ ...p, [key]: e.target.value }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIssues([]);
    setErrorMsg(null);
    const input = formToWriteInput(values);
    startTransition(async () => {
      const res =
        mode === "create"
          ? await createContractAction(input)
          : await updateContractAction(contractId as string, input);
      if (res.ok) {
        router.push(`/contracts/${res.id}`);
        return;
      }
      if (res.error === "invalid_input") {
        setIssues(res.issues);
        return;
      }
      setErrorMsg(writeErrorMessage(res.error));
    });
  }

  const statusOptions = statusOptionsForValue(values.status);

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {errorMsg ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950">
          {errorMsg}
        </p>
      ) : null}
      {issues.length > 0 ? (
        <ul className="list-inside list-disc rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}

      <Field label="Contract name" htmlFor="contractName" required>
        <input
          id="contractName"
          name="contractName"
          required
          value={values.contractName}
          onChange={set("contractName")}
          className={inputClass}
        />
      </Field>

      <Field label="Vendor" htmlFor="vendorName">
        <input
          id="vendorName"
          name="vendorName"
          value={values.vendorName}
          onChange={set("vendorName")}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Status" htmlFor="status">
          <select id="status" name="status" value={values.status} onChange={set("status")} className={inputClass}>
            {statusOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Renewal responsibility" htmlFor="renewalResponsibility">
          <input
            id="renewalResponsibility"
            name="renewalResponsibility"
            value={values.renewalResponsibility}
            onChange={set("renewalResponsibility")}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Total cost" htmlFor="totalCost" hint="The whole contract value (v3 has no monthly-cost field — see docs/15).">
          <input
            id="totalCost"
            name="totalCost"
            type="number"
            step="0.01"
            value={values.totalCost}
            onChange={set("totalCost")}
            className={inputClass}
          />
        </Field>
        <Field label="Currency" htmlFor="currency">
          <input
            id="currency"
            name="currency"
            value={values.currency}
            onChange={set("currency")}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <Field label="Start date" htmlFor="startDate">
          <input id="startDate" name="startDate" type="date" value={values.startDate} onChange={set("startDate")} className={inputClass} />
        </Field>
        <Field label="Renewal date" htmlFor="renewalDate">
          <input id="renewalDate" name="renewalDate" type="date" value={values.renewalDate} onChange={set("renewalDate")} className={inputClass} />
        </Field>
        <Field label="Expiry / end date" htmlFor="endDate">
          <input id="endDate" name="endDate" type="date" value={values.endDate} onChange={set("endDate")} className={inputClass} />
        </Field>
      </div>

      {/* ponytail: the org <select> lists only the caller's RLS-visible orgs. If a contract's current
          org is outside that set, the control shows unselected — but the controlled value is retained,
          so an untouched edit never changes it; and anyone who can actually save (a tenant member) sees
          their tenant's orgs. Add a "(current)" option only if a real editor case needs it. */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Procurement org" htmlFor="procurementOrgId" hint="The accountable owning org (write anchor).">
          <select
            id="procurementOrgId"
            name="procurementOrgId"
            value={values.procurementOrgId}
            onChange={set("procurementOrgId")}
            className={inputClass}
          >
            <option value="">— None —</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Paying org" htmlFor="payingOrgId" hint="Read/chargeback signal only — does not grant edit access.">
          <select id="payingOrgId" name="payingOrgId" value={values.payingOrgId} onChange={set("payingOrgId")} className={inputClass}>
            <option value="">— None —</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900"
        >
          {pending ? "Saving…" : mode === "create" ? "Create contract" : "Save changes"}
        </button>
        <Link href={cancelHref} className="text-sm text-zinc-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
