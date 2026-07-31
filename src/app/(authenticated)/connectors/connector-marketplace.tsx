"use client";
import { useMemo, useState, useId } from "react";
import { ConnectorCard } from "./connector-card";
import { useDemoConnectionsRaw } from "@/lib/customer-connectors/use-demo-connection";
import { parseDemoRaw } from "@/lib/customer-connectors/demo-store";
import { matchesStatusFilter, type RealConnectorState, type StatusFilter } from "@/lib/customer-connectors/view";
import { CUSTOMER_CATEGORIES, type CustomerConnector, type CustomerCategory } from "@/lib/customer-connectors/catalog-types";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "connected", label: "Connected" },
  { key: "available", label: "Available" },
  { key: "coming_soon", label: "Coming soon" },
];

// The customer connector marketplace: instant client-side search + category/status filters over the catalog, with the preview
// (sessionStorage) connection state overlaid. Keyboard accessible; responsive card grid. No internal/technical wording.
export function ConnectorMarketplace({ connectors, realStates = {} }: { connectors: CustomerConnector[]; realStates?: Record<string, RealConnectorState> }) {
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
      if (!matchesStatusFilter(c, demoMap[c.provider] ?? null, status, realStates[c.provider] ?? null)) return false;
      return true;
    });
  }, [connectors, query, category, status, demoMap, realStates]);

  // Status pills are the primary filter (standard weight); category pills are visually secondary (smaller, lighter).
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900" : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"}`;
  const catPill = (active: boolean) =>
    `rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${active ? "border-zinc-700 bg-zinc-100 text-zinc-900 dark:border-zinc-400 dark:bg-zinc-800 dark:text-zinc-100" : "border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-800 dark:text-zinc-400"}`;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {/* Prominent search */}
        <div>
          <label htmlFor={searchId} className="sr-only">Search connectors</label>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connectors…"
            className="w-full max-w-lg rounded-lg border border-zinc-300 px-3.5 py-2.5 text-sm shadow-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        {/* Status — primary filter, directly under search */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={status === s.key} onClick={() => setStatus(s.key)} className={pill(status === s.key)}>{s.label}</button>
          ))}
        </div>
        {/* Category — secondary filter */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by category">
          <span aria-hidden="true" className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Category</span>
          <button type="button" aria-pressed={category === "all"} onClick={() => setCategory("all")} className={catPill(category === "all")}>All categories</button>
          {CUSTOMER_CATEGORIES.map((cat) => (
            <button key={cat} type="button" aria-pressed={category === cat} onClick={() => setCategory(cat)} className={catPill(category === cat)}>{cat}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 p-6 text-center text-sm dark:border-zinc-800">
          <div className="font-medium">No connectors match your search</div>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">Try a different search or clear the filters.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <li key={c.provider}><ConnectorCard connector={c} real={realStates[c.provider] ?? null} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
