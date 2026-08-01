"use client";
import Link from "next/link";
import { Badge } from "@/components/badge";
import { ConnectorIcon } from "@/components/connector-icon";
import type { ProviderCardModel } from "@/lib/customer-connectors/provider-instances";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

// One provider card, carrying two separate facts.
//
//   The BADGE describes the PRODUCT: Available / Preview / Coming soon. It is the same for every customer.
//   The INSTANCE LIST describes THIS WORKSPACE: what is configured and how far each one got.
//
// Keeping them apart is the whole point of Phase 5B. A synthetic Entra connector can exist while Entra ingestion does not — the
// card says "Preview" and "Configuration saved" simultaneously, and neither contradicts the other. Collapsing them into one
// status was what produced "Connection coming soon" on a provider the workspace had already configured.
//
// Browser-local demo state is not consulted here at all. Persisted state is the only state.

// Lifecycle tone. Only `discovered` earns success: a saved configuration is not a working connector, and a verified one has not
// imported anything yet.
const LIFECYCLE_TONE: Record<string, "success" | "attention" | "danger" | "neutral"> = {
  discovered: "success", discovering: "attention", verified: "attention", configured: "attention",
  failed: "danger", disconnected: "neutral", superseded: "neutral",
};

export function ProviderCard({ connector, model }: { connector: CustomerConnector; model: ProviderCardModel }) {
  const comingSoon = model.availabilityLabel === "Coming soon";
  const cardClass = comingSoon
    ? "border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40"
    : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700";

  return (
    <div className={`flex h-full flex-col gap-3 rounded-xl border p-4 transition-colors ${cardClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <ConnectorIcon initial={connector.icon.initial} tint={connector.icon.tint} size="md" />
          <div className="min-w-0">
            <div className={`truncate text-[15px] font-semibold ${comingSoon ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-900 dark:text-zinc-100"}`}>{connector.displayName}</div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{connector.category}</div>
          </div>
        </div>
        {/* About the product, never about this workspace. */}
        <Badge tone={model.availabilityLabel === "Available" ? "success" : "neutral"} variant="solid">{model.availabilityLabel}</Badge>
      </div>

      <p className="line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{connector.description}</p>

      {model.availabilityNote && <p className="text-xs text-zinc-500">{model.availabilityNote}</p>}

      {/* ── This workspace's instances ─────────────────────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        <div className="text-xs font-medium text-zinc-500">{model.instanceSummary}</div>
        {model.instances.length > 0 && (
          <ul className="space-y-1.5">
            {/* Every instance is listed, never collapsed into one badge — two Okta organizations at different lifecycles are two
                separate facts and a single summary would have to be wrong about one of them. */}
            {model.instances.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <Link href={`/connectors/manage/${i.id}`} className="font-medium underline-offset-2 hover:underline">{i.name}</Link>
                <Badge tone={LIFECYCLE_TONE[i.lifecycle] ?? "neutral"}>{i.lifecycleLabel}</Badge>
                {i.organization && i.organization !== i.name && <span className="text-zinc-400">{i.organization}</span>}
                {i.active && i.lifecycle === "discovered" && (
                  <span className="text-zinc-500">{i.counts.people} people · {i.counts.groups} groups · {i.counts.applications} apps</span>
                )}
                {!i.active && <span className="text-zinc-400">history preserved</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {model.primary ? (
          <Link href={model.primary.href} className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
            {model.primary.label}
          </Link>
        ) : (
          // A coming-soon provider with nothing configured gets no action rather than a button that cannot work.
          <span aria-disabled="true" className="rounded-md border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">Coming soon</span>
        )}
        {model.secondary && (
          <Link href={model.secondary.href} className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:border-zinc-400 dark:border-zinc-600">
            {model.secondary.label}
          </Link>
        )}
      </div>
    </div>
  );
}
