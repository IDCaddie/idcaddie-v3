import Link from "next/link";
import { listEntitlementsForContract } from "@/lib/data/contract-entitlements";
import { loadConnectorManagement } from "@/lib/data/connector-management";
import { EntitlementForm, type ConnectorOption, type EntitlementFormValues } from "../../../entitlement-form";

export const metadata = { title: "Edit purchased line · ID Caddie" };

// Edit route for one purchased line. The line is found in the contract's own RLS-scoped list rather than by a dedicated
// single-row query: the list is already the authorized read, and an id the caller may not see simply is not in it — the same
// "not found" a non-existent id gives, with no enumeration and no second query to keep in sync.
export default async function EditEntitlementPage({
  params,
}: {
  params: Promise<{ id: string; entitlementId: string }>;
}) {
  const { id, entitlementId } = await params;
  const lines = await listEntitlementsForContract(id);
  const line = lines.ok ? lines.data.find((l) => l.id === entitlementId) : undefined;

  if (!line) {
    return (
      <main className="flex flex-1 flex-col gap-6 p-8">
        <div className="text-sm">
          <Link href={`/contracts/${id}`} className="text-zinc-500 hover:underline">← Back to contract</Link>
        </div>
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">Purchased line not found</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            This line doesn’t exist or you don’t have access to it.
          </p>
        </div>
      </main>
    );
  }

  const connectors = await loadConnectorManagement();
  const options: ConnectorOption[] = connectors.ok
    ? connectors.data.connectors.filter((c) => c.active).map((c) => ({ id: c.id, label: `${c.name} (${c.provider})` }))
    : [];

  // Null → "" for the controlled inputs. The parser turns "" back into NULL on the way out, so an unrecorded quantity makes
  // the round trip without ever becoming 0.
  const s = (v: string | number | null): string => (v === null ? "" : String(v));
  const initial: EntitlementFormValues = {
    contractId: id,
    sku: s(line.sku), planName: s(line.planName),
    purchasedQuantity: s(line.purchasedQuantity), minimumQuantity: s(line.minimumQuantity),
    quantityUnit: line.quantityUnit,
    unitAmount: s(line.unitAmount), currency: s(line.currency), billingFrequency: s(line.billingFrequency),
    termStart: s(line.termStart), termEnd: s(line.termEnd),
    measuredByConnectionId: s(line.measuredByConnectionId),
    vendorId: s(line.vendorId), appProductId: s(line.appProductId), appId: "",
    source: line.source, confidence: line.confidence,
    evidenceFileId: "", evidenceNote: s(line.evidenceNote),
  };

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href={`/contracts/${id}`} className="text-zinc-500 hover:underline">← Back to contract</Link>
        </div>
        <h1 className="text-xl font-semibold">Edit purchased line</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Changes are recorded against your account. Clearing a quantity records it as unknown, not as zero.
        </p>
      </header>
      <div className="max-w-3xl">
        <EntitlementForm
          mode="edit"
          entitlementId={line.id}
          contractId={id}
          initial={initial}
          connectors={options}
          connectorsReadable={connectors.ok}
        />
      </div>
    </main>
  );
}
