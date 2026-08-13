"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createEntitlementAction, updateEntitlementAction } from "./entitlement-actions";
import {
  BILLING_FREQUENCIES, CONFIDENCE_LEVELS, ENTITLEMENT_SOURCES, QUANTITY_UNITS,
  type EntitlementWriteInput,
} from "@/lib/data/entitlement-write";

// The purchased-line create/edit form. A Client Component for controlled inputs, holding NO authorization logic: it posts to
// the server actions and Postgres RLS (0084) decides whether the save lands. tenant_id is never sent.
//
// EVERY QUANTITY FIELD IS OPTIONAL AND STARTS EMPTY, and that is a product decision, not laziness. A blank seat box must
// record NULL — "we have not been told" — because the reconciliation treats that differently from a purchase of zero. A
// `defaultValue={0}` anywhere here would silently populate the database with claims nobody made.
//
// ponytail: no vendor / product / application / evidence-document pickers. Those columns exist on 0084 and are writable, but
// no picker UI exists for canonical rows and building three of them is a phase of its own. Add them when the duplicate rule
// (which needs app_product_id) is wanted in practice.

export type EntitlementFormValues = EntitlementWriteInput;

export const emptyEntitlementForm = (contractId: string): EntitlementFormValues => ({
  contractId,
  sku: "", planName: "", purchasedQuantity: "", minimumQuantity: "", quantityUnit: "seat",
  unitAmount: "", currency: "USD", billingFrequency: "", termStart: "", termEnd: "",
  measuredByConnectionId: "", vendorId: "", appProductId: "", appId: "",
  source: "manual_entry", confidence: "low", evidenceFileId: "", evidenceNote: "",
});

export type ConnectorOption = { readonly id: string; readonly label: string };

const inputClass = "w-full rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

const errorMessage = (error: Exclude<Awaited<ReturnType<typeof createEntitlementAction>>, { ok: true }>["error"]): string => {
  switch (error) {
    case "not_authenticated": return "Your session has expired. Please sign in again.";
    case "no_tenant": return "Your account isn't part of a workspace that can hold contracts, so this couldn't be saved.";
    // Deliberately indistinguishable from "no longer exists" — the form must never reveal whether a forbidden row exists.
    case "not_allowed": return "You don't have permission to save this line, or the contract no longer exists.";
    case "invalid_input": return "Please fix the highlighted fields and try again.";
    default: return "Something went wrong saving this line. Please try again.";
  }
};

export function EntitlementForm({
  mode, entitlementId, contractId, initial, connectors, connectorsReadable,
}: {
  mode: "create" | "edit";
  entitlementId?: string;
  contractId: string;
  initial: EntitlementFormValues;
  connectors: readonly ConnectorOption[];
  connectorsReadable: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<EntitlementFormValues>(initial);
  const [issues, setIssues] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof EntitlementFormValues) => (e: { target: { value: string } }) =>
    setValues((p) => ({ ...p, [key]: e.target.value }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIssues([]);
    setErrorMsg(null);
    startTransition(async () => {
      const res = mode === "create"
        ? await createEntitlementAction(values)
        : await updateEntitlementAction(entitlementId as string, values);
      if (res.ok) {
        router.push(`/contracts/${contractId}`);
        router.refresh();
        return;
      }
      if (res.error === "invalid_input") setIssues(res.issues);
      setErrorMsg(errorMessage(res.error));
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {errorMsg ? (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <p>{errorMsg}</p>
          {issues.length > 0 ? (
            <ul className="mt-2 list-inside list-disc">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          ) : null}
        </div>
      ) : null}

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">What was bought</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="SKU" htmlFor="sku" hint="The vendor's own code for this line, if the paperwork gives one.">
            <input id="sku" className={inputClass} value={values.sku} onChange={set("sku")} />
          </Field>
          <Field label="Plan name" htmlFor="planName">
            <input id="planName" className={inputClass} value={values.planName} onChange={set("planName")} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">How much</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Purchased quantity" htmlFor="purchasedQuantity" hint="Leave blank if it is not known. Blank is not zero.">
            <input id="purchasedQuantity" inputMode="numeric" className={inputClass} value={values.purchasedQuantity} onChange={set("purchasedQuantity")} />
          </Field>
          <Field label="Contracted minimum" htmlFor="minimumQuantity" hint="Any floor you cannot reduce below. Used to stop a savings estimate overstating itself.">
            <input id="minimumQuantity" inputMode="numeric" className={inputClass} value={values.minimumQuantity} onChange={set("minimumQuantity")} />
          </Field>
          <Field label="Unit" htmlFor="quantityUnit">
            <select id="quantityUnit" className={inputClass} value={values.quantityUnit} onChange={set("quantityUnit")}>
              {QUANTITY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">What it costs</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Unit price" htmlFor="unitAmount" hint="Price for ONE unit per billing period.">
            <input id="unitAmount" inputMode="decimal" className={inputClass} value={values.unitAmount} onChange={set("unitAmount")} />
          </Field>
          <Field label="Currency" htmlFor="currency">
            <input id="currency" maxLength={3} className={inputClass} value={values.currency} onChange={set("currency")} />
          </Field>
          <Field label="Billing frequency" htmlFor="billingFrequency" hint="A price needs a currency and a frequency, or no annual figure can follow from it.">
            <select id="billingFrequency" className={inputClass} value={values.billingFrequency} onChange={set("billingFrequency")}>
              <option value="">—</option>
              {BILLING_FREQUENCIES.map((f) => <option key={f} value={f}>{f.replace("_", " ")}</option>)}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">When, and what measures it</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Term start" htmlFor="termStart">
            <input id="termStart" type="date" className={inputClass} value={values.termStart} onChange={set("termStart")} />
          </Field>
          <Field label="Term end" htmlFor="termEnd">
            <input id="termEnd" type="date" className={inputClass} value={values.termEnd} onChange={set("termEnd")} />
          </Field>
          <Field
            label="Measured by"
            htmlFor="measuredByConnectionId"
            hint={
              connectorsReadable
                ? "The connector whose accounts this line should be compared with. Nothing is matched by name."
                : "Connectors are not readable with your access, so a measurement source cannot be declared here."
            }
          >
            <select id="measuredByConnectionId" className={inputClass} value={values.measuredByConnectionId} onChange={set("measuredByConnectionId")} disabled={!connectorsReadable}>
              <option value="">Not measured</option>
              {connectors.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">Where these figures came from</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Source" htmlFor="source">
            <select id="source" className={inputClass} value={values.source} onChange={set("source")}>
              {ENTITLEMENT_SOURCES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Confidence" htmlFor="confidence" hint="A finding is never more certain than the figure behind it.">
            <select id="confidence" className={inputClass} value={values.confidence} onChange={set("confidence")}>
              {CONFIDENCE_LEVELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Evidence note" htmlFor="evidenceNote" hint="e.g. “order form p.3, line 2”.">
            <input id="evidenceNote" className={inputClass} value={values.evidenceNote} onChange={set("evidenceNote")} />
          </Field>
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Saving…" : mode === "create" ? "Add line" : "Save line"}
        </button>
        <Link href={`/contracts/${contractId}`} className="text-sm text-zinc-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
