"use client";
import { useMemo, useState, useId } from "react";
import { ProviderCard } from "./connector-card";
import {
  providerCard, matchesProviderFilter, PROVIDER_FILTERS, PROVIDER_FILTER_LABEL,
  type ProviderFilter, type ProviderInstance,
} from "@/lib/customer-connectors/provider-instances";
import { CUSTOMER_CATEGORIES, type CustomerConnector, type CustomerCategory } from "@/lib/customer-connectors/catalog-types";

// The marketplace: providers ID Caddie supports, each reconciled with the connector instances this workspace has.
//
// The status filter is "Configured", not "Connected". A saved configuration is not a live connection, and the old label counted
// one as the other — which is the same class of untruth as a card saying "coming soon" about a provider the workspace had already
// configured.

export function ConnectorMarketplace({
  connectors, instances, instanceState,
}: {
  connectors: CustomerConnector[];
  instances: readonly ProviderInstance[];
  instanceState: "ok" | "forbidden" | "unavailable";
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CustomerCategory | "all">("all");
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const searchId = useId();

  const cards = useMemo(() => connectors.map((c) => ({ connector: c, model: providerCard(c, instances) })), [connectors, instances]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter(({ connector, model }) => {
      if (q && !connector.displayName.toLowerCase().includes(q) && !connector.category.toLowerCase().includes(q)
            && !model.instances.some((i) => i.name.toLowerCase().includes(q) || (i.organization ?? "").toLowerCase().includes(q))) return false;
      if (category !== "all" && connector.category !== category) return false;
      return matchesProviderFilter(model, filter);
    });
  }, [cards, query, category, filter]);

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900" : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"}`;
  const catPill = (active: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${active ? "border-zinc-700 bg-zinc-100 text-zinc-900 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-100" : "border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-800 dark:text-zinc-400"}`;

  return (
    <div className="space-y-4">
      {/* A read failure must never render as "nothing configured" — that would show an empty estate because a query timed out. */}
      {instanceState !== "ok" && (
        <div role="status" className="max-w-3xl rounded border border-zinc-300 p-3 text-sm dark:border-zinc-700">
          {instanceState === "forbidden"
            ? "You're seeing which integrations ID Caddie supports. Viewing the connectors this workspace has configured requires an owner or admin."
            : "The connectors configured in this workspace could not be loaded, so only provider availability is shown below. This is not a statement that none exist."}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label htmlFor={searchId} className="sr-only">Search connectors</label>
          <input
            id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers or connectors…"
            className="w-full max-w-lg rounded-lg border border-zinc-300 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {PROVIDER_FILTERS.map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={pill(filter === f)}>
              {PROVIDER_FILTER_LABEL[f]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setCategory("all")} aria-pressed={category === "all"} className={catPill(category === "all")}>All categories</button>
          {CUSTOMER_CATEGORIES.map((c) => (
            <button key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c} className={catPill(category === c)}>{c}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
          <div className="font-medium">No providers match</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">Adjust the search or filters above.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(({ connector, model }) => (
            <li key={connector.provider}><ProviderCard connector={connector} model={model} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
