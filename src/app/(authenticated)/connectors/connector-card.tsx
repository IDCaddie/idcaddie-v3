"use client";
import Link from "next/link";
import { Badge } from "@/components/badge";
import { ConnectorIcon } from "@/components/connector-icon";
import { useDemoConnection } from "@/lib/customer-connectors/use-demo-connection";
import { resolveConnectorView, type RealConnectorState } from "@/lib/customer-connectors/view";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

// One marketplace card. Reads the sessionStorage demo state reactively so a preview connect/pause/disconnect updates the card
// live. Visual hierarchy: prominent name + icon, muted category, a strong CTA for the connectable provider, a muted (still
// accessible) treatment for coming-soon. No internal state, no secret/id/technical wording — customer copy only.
export function ConnectorCard({ connector, real }: { connector: CustomerConnector; real?: RealConnectorState | null }) {
  const demo = useDemoConnection(connector.provider);
  const view = resolveConnectorView(connector, demo, real);
  const comingSoon = view.cta.disabled;
  const strong = connector.canConnect && !demo && !real; // the "Connect …" call to action

  const cardClass = comingSoon
    ? "border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40"
    : "border-zinc-200 hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:hover:border-zinc-700";

  const ctaClass = comingSoon
    ? "rounded-md border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
    : strong
      ? "rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-white dark:text-zinc-900"
      : "rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-600";

  const inner = (
    <div className={`flex h-full flex-col gap-3 rounded-xl border p-4 transition-colors ${cardClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <ConnectorIcon initial={connector.icon.initial} tint={connector.icon.tint} size="md" />
          <div className="min-w-0">
            <div className={`truncate text-[15px] font-semibold ${comingSoon ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-900 dark:text-zinc-100"}`}>{connector.displayName}</div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{connector.category}</div>
          </div>
        </div>
        <Badge tone={view.statusTone} variant="solid">{view.statusLabel}</Badge>
      </div>
      {/* The note qualifies the badge — "Failed" alone does not say whether the customer must do anything, and
          "Simulated" alone does not say it is not a real connection. Both were computed and then dropped on the floor. */}
      {view.statusNote && (
        <p className={`-mt-1 text-[11px] ${view.statusTone === "danger" ? "text-red-700 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400"}`}>{view.statusNote}</p>
      )}
      <p className="line-clamp-2 min-h-[2.5rem] text-sm text-zinc-600 dark:text-zinc-400">{connector.description}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <div className="flex min-w-0 flex-wrap gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          {connector.capabilities.slice(0, 2).map((cap) => (
            <span key={cap} className="rounded border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-800">{cap}</span>
          ))}
        </div>
        <span aria-disabled={comingSoon ? "true" : undefined} className={`shrink-0 ${ctaClass}`}>{view.cta.label}</span>
      </div>
    </div>
  );

  // The whole card is a link when there is a destination; a coming-soon card is inert. h-full on the wrapper lets the inner
  // card's h-full resolve against the stretched grid item, so every card in a row is equal height (Phase 2).
  return view.cta.href ? (
    <Link href={view.cta.href} aria-label={`${connector.displayName} — ${view.statusLabel}`} className="block h-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500">
      {inner}
    </Link>
  ) : (
    <div className="h-full">{inner}</div>
  );
}
