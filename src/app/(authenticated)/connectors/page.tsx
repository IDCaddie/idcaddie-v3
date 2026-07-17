import Link from "next/link";
import { listCustomerConnectors } from "@/lib/customer-connectors/catalog";
import { ConnectorMarketplace } from "./connector-marketplace";

export const metadata = { title: "Connectors · ID Caddie" };

// The customer connector marketplace. Browse / search / filter available app connectors and see connection status. Everything is
// PREVIEW-ONLY: connecting runs a simulated flow, nothing syncs, no credentials are stored, no provider is activated. The catalog
// is safe display metadata (src/lib/customer-connectors) — it never surfaces internal governance/registry/pilot/ECS/secret state.
// The read-only sync-review workflow (a separate role-gated route) is preserved via the link below.
export default async function ConnectorsPage() {
  const connectors = listCustomerConnectors();
  return (
    <main className="flex flex-1 flex-col gap-5 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Connect your business apps to discover users, access, and software usage.</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">Preview connectors do not import data.</p>
      </header>

      <ConnectorMarketplace connectors={connectors} />

      <footer className="border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Already reviewing discovered items?{" "}
        <Link href="/connectors/review" className="underline hover:text-zinc-700 dark:hover:text-zinc-200">Go to sync review</Link>.
      </footer>
    </main>
  );
}
