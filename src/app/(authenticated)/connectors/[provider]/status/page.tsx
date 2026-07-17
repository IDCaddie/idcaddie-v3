import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomerConnector } from "@/lib/customer-connectors/catalog";
import { ConnectorStatusView } from "./connector-status-view";

export const metadata = { title: "Connection · ID Caddie" };

// The connection management page for a preview connection. Server component validates the provider; the demo-state-driven
// management UI is a client island. No server execution/schedule/credential path exists here.
export default async function ConnectorStatusPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const c = getCustomerConnector(provider);
  if (!c) notFound();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href={`/connectors/${provider}`} className="text-zinc-500 hover:underline">← {c.displayName}</Link>
      </div>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{c.displayName} connection</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Manage your preview connection. Nothing syncs until a connection is fully ready.</p>
      </header>
      <ConnectorStatusView connector={c} />
    </main>
  );
}
