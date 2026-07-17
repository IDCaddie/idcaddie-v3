"use client";
import Link from "next/link";
import { Badge } from "@/components/badge";
import { ConnectorIcon } from "@/components/connector-icon";
import { useDemoConnection } from "@/lib/customer-connectors/use-demo-connection";
import { resolveConnectorView } from "@/lib/customer-connectors/view";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

// One marketplace card. Reads the sessionStorage demo state reactively so a preview connect/pause/disconnect updates the card
// live. No internal state, no secret/id/technical wording — customer copy only.
export function ConnectorCard({ connector }: { connector: CustomerConnector }) {
  const demo = useDemoConnection(connector.provider);
  const view = resolveConnectorView(connector, demo);
  const inner = (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-zinc-200 p-4 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <ConnectorIcon initial={connector.icon.initial} tint={connector.icon.tint} />
          <div>
            <div className="font-medium">{connector.displayName}</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">{connector.category}</div>
          </div>
        </div>
        <Badge tone={view.statusTone} variant="solid">{view.statusLabel}</Badge>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{connector.description}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <div className="flex flex-wrap gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          {connector.capabilities.slice(0, 2).map((cap) => (
            <span key={cap} className="rounded border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-800">{cap}</span>
          ))}
        </div>
        {view.cta.disabled ? (
          <span aria-disabled="true" className="rounded border border-zinc-200 px-3 py-1.5 text-xs text-zinc-400 dark:border-zinc-800">{view.cta.label}</span>
        ) : (
          <span className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700">{view.cta.label}</span>
        )}
      </div>
    </div>
  );
  // The whole card is a link when there is a destination; a coming-soon card is inert.
  return view.cta.href ? (
    <Link href={view.cta.href} aria-label={`${connector.displayName} — ${view.statusLabel}`} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500">
      {inner}
    </Link>
  ) : (
    <div aria-label={`${connector.displayName} — ${view.statusLabel} (coming soon)`}>{inner}</div>
  );
}
