import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCustomerConnector } from "@/lib/customer-connectors/catalog";
import { OktaConnectWizard } from "./okta-connect-wizard";

export const metadata = { title: "Connect · ID Caddie" };

// The preview connection wizard route. Only a provider with a preview connect flow (Okta this phase) reaches the wizard; anything
// else is sent back to its detail page — there is NO connect flow for a non-previewable provider (fail-closed).
export default async function ConnectPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const c = getCustomerConnector(provider);
  if (!c) notFound();
  if (!c.canConnect) redirect(`/connectors/${provider}`);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href={`/connectors/${provider}`} className="text-zinc-500 hover:underline">← {c.displayName}</Link>
      </div>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Connect {c.displayName}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">A quick, guided preview of connecting {c.displayName} to ID Caddie.</p>
      </header>
      <OktaConnectWizard provider={provider} />
    </main>
  );
}
