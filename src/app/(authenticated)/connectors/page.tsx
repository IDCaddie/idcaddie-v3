import Link from "next/link";
import { listCustomerConnectors } from "@/lib/customer-connectors/catalog";
import { loadConnectorManagement } from "@/lib/data/connector-management";
import type { ProviderInstance } from "@/lib/customer-connectors/provider-instances";
import { ConnectorMarketplace } from "./connector-marketplace";

export const metadata = { title: "Connectors · ID Caddie" };

// The provider catalogue, reconciled with what this workspace has actually configured.
//
// Phase 5B fixed the split brain: this page used to ask `getOktaConnectorStatus()`, which reads `okta_connector_configs` — a table
// only Okta has. Every other provider fell through to its static "Preview / Connection coming soon" label even when a real
// connector row existed, and the override was keyed one-per-provider so a second Okta organization could not be shown at all.
//
// It now reads the provider-agnostic connector inventory, so a card reflects EVERY instance of its provider. Provider availability
// and instance lifecycle stay separate: "Preview" describes what ID Caddie supports, "Configuration saved" describes what this
// workspace has. Both can be true at once, and a synthetic Entra connector is exactly that case.

// Phase 8K: the OAuth callback's failure destination is `/connectors?oauth=error&reason=<bounded code>`, and until now
// nothing rendered it — a customer who clicked "Allow" at Slack and hit any refusal was returned to the ordinary
// marketplace with no indication the flow had failed, unable to tell it apart from silent success.
// (Found in adversarial review of PR #398.)
//
// The reason code is an ENGINEERING code, not customer language, so it is never displayed. It is used only to choose
// between two sentences, and anything unrecognised falls to the generic one.
function oauthBanner(oauth: string | undefined, reason: string | undefined): string | null {
  if (oauth !== "error") return null;
  if (reason === "expired" || reason === "replayed") {
    return "That Slack connection request is no longer valid. Please start the connection again.";
  }
  return "We could not complete your Slack connection. Nothing was connected. Please try again.";
}

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
} = {}) {
  const sp = (await searchParams) ?? {};
  const banner = oauthBanner(
    typeof sp.oauth === "string" ? sp.oauth : undefined,
    typeof sp.reason === "string" ? sp.reason : undefined,
  );
  const connectors = listCustomerConnectors();

  // Owner/admin-gated, like every other read of tenant connector state. A forbidden result is NOT the same as "no instances":
  // showing a viewer "No connector instances" would be a lie, so the marketplace says instance visibility needs an admin instead.
  const inv = await loadConnectorManagement().catch(() => null);
  const instances: ProviderInstance[] = inv?.ok ? inv.data.connectors.map((c) => ({
    id: c.id, provider: c.provider, name: c.name, organization: c.organization,
    lifecycle: c.lifecycle, lifecycleLabel: c.lifecycleLabel, active: c.active, supersededBy: c.supersededBy,
    counts: { people: c.counts.people, groups: c.counts.groups, applications: c.counts.applications },
  })) : [];

  // Three outcomes, told apart deliberately: readable, not permitted, and failed. A read failure must never render as "nothing
  // configured" — that would show a customer an empty estate because a query timed out.
  const instanceState: "ok" | "forbidden" | "unavailable" =
    inv?.ok ? "ok" : inv?.error === "forbidden" ? "forbidden" : "unavailable";

  return (
    <main className="flex flex-1 flex-col gap-5 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">← Back</Link>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          The integrations ID Caddie supports, and the connectors this workspace has configured. Provider availability describes
          what the product can do; each connector below shows what your workspace has actually set up.
        </p>
      </header>

      {banner ? (
        <p
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {banner}
        </p>
      ) : null}

      <ConnectorMarketplace connectors={connectors} instances={instances} instanceState={instanceState} />

      <footer className="border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Managing what you already connected?{" "}
        <Link href="/connectors/manage" className="underline hover:text-zinc-700 dark:hover:text-zinc-200">Go to Directories</Link>.
      </footer>
    </main>
  );
}
