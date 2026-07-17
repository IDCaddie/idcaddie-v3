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
    // Clean page background with the setup card as the visual focus (the wizard renders the card).
    <main className="flex flex-1 flex-col items-center bg-zinc-50 px-4 py-8 dark:bg-zinc-950">
      <div className="w-full max-w-[720px] space-y-4">
        <div className="text-sm">
          <Link href={`/connectors/${provider}`} className="text-zinc-500 hover:underline">← {c.displayName}</Link>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Connect {c.displayName}</h1>
        <OktaConnectWizard provider={provider} />
      </div>
    </main>
  );
}
