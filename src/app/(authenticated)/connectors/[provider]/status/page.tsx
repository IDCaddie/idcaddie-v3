import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomerConnector } from "@/lib/customer-connectors/catalog";
import { getOktaConnectorStatus } from "@/lib/data/okta-connector-status";
import { OktaStatusPanel } from "./okta-status-panel";
import { ConnectorStatusView } from "./connector-status-view";

export const metadata = { title: "Connection · ID Caddie" };

// The connection page. For a provider with a REAL persisted configuration this server-renders the actual lifecycle from
// `connectors` + `okta_connector_configs` through RLS. The older demo-state island is only reached when no real configuration
// exists, and it is labelled as simulated there — so a browser-local preview can never be mistaken for a live connector.
export default async function ConnectorStatusPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const c = getCustomerConnector(provider);
  if (!c) notFound();

  const status = provider === "okta" ? await getOktaConnectorStatus() : null;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href={`/connectors/${provider}`} className="text-zinc-500 hover:underline">← {c.displayName}</Link>
      </div>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{c.displayName} connection</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {status
            ? "Configuration, verification and discovery status for your Okta organization."
            : "Manage your preview connection. Nothing syncs until a connection is fully ready."}
        </p>
      </header>
      {status ? <OktaStatusPanel status={status} /> : <ConnectorStatusView connector={c} />}
    </main>
  );
}
