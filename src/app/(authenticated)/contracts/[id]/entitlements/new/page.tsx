import Link from "next/link";
import { loadConnectorManagement } from "@/lib/data/connector-management";
import { EntitlementForm, emptyEntitlementForm, type ConnectorOption } from "../../entitlement-form";

export const metadata = { title: "Add purchased line · ID Caddie" };

// Create route for a purchased line. Server-rendered shell + the connector list; the form (a Client Component) posts to the
// server action. No authorization here — RLS (0083) decides whether the save lands, and the affordance may be shown to a
// reader for usability exactly as the contract form is.
export default async function NewEntitlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Connector reads are owner/admin only (0078). A reader without that access still gets the form — they simply cannot
  // declare a measurement source, which the form says in words rather than showing an empty select with no explanation.
  const connectors = await loadConnectorManagement();
  const options: ConnectorOption[] = connectors.ok
    ? connectors.data.connectors.filter((c) => c.active).map((c) => ({ id: c.id, label: `${c.name} (${c.provider})` }))
    : [];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href={`/contracts/${id}`} className="text-zinc-500 hover:underline">
            ← Back to contract
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Add a purchased line</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Record what this contract bought. Every field is optional — a quantity left blank is recorded as unknown, which
          is not the same as zero.
        </p>
      </header>
      <div className="max-w-3xl">
        <EntitlementForm
          mode="create"
          contractId={id}
          initial={emptyEntitlementForm(id)}
          connectors={options}
          connectorsReadable={connectors.ok}
        />
      </div>
    </main>
  );
}
