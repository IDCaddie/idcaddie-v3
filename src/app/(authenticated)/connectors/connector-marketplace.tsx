"use client";
import { useMemo, useState, useId } from "react";
import { ConnectorCard } from "./connector-card";
import { useDemoConnectionsRaw } from "@/lib/customer-connectors/use-demo-connection";
import { parseDemoRaw } from "@/lib/customer-connectors/demo-store";
import { matchesStatusFilter, type StatusFilter } from "@/lib/customer-connectors/view";
import { CUSTOMER_CATEGORIES, type CustomerConnector, type CustomerCategory } from "@/lib/customer-connectors/catalog-types";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "connected", label: "Connected" },
  { key: "available", label: "Available" },
  { key: "coming_soon", label: "Coming soon" },
];

// The customer connector marketplace: instant client-side search + category/status filters over the catalog, with the preview
// (sessionStorage) connection state overlaid. Keyboard accessible; responsive card grid. No internal/technical wording.
export function ConnectorMarketplace({ connectors }: { connectors: CustomerConnector[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CustomerCategory | "all">("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const searchId = useId();
  const raw = useDemoConnectionsRaw();
  const demoMap = useMemo(() => parseDemoRaw(raw), [raw]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connectors.filter((c) => {
      if (q && !c.displayName.toLowerCase().includes(q) && !c.category.toLowerCase().includes(q)) return false;
      if (category !== "all" && c.category !== category) return false;
      if (!matchesStatusFilter(c, demoMap[c.provider] ?? null, status)) return false;
      return true;
    });
  }, [connectors, query, category, status, demoMap]);

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900" : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor={searchId} className="sr-only">Search connectors</label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors…"
            className="w-full max-w-md rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={status === s.key} onClick={() => setStatus(s.key)} className={pill(status === s.key)}>{s.label}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")} className={pill(category === "all")}>All categories</button>
          {CUSTOMER_CATEGORIES.map((cat) => (
            <button key={cat} type="button" aria-pressed={category === cat} onClick={() => setCategory(cat)} className={pill(category === cat)}>{cat}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-zinc-300 p-6 text-center text-sm dark:border-zinc-700">
          <div className="font-medium">No connectors match your search</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">Try a different search or clear the filters.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <li key={c.provider}><ConnectorCard connector={c} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
