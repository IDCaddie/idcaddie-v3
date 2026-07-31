import Link from "next/link";
import { Badge } from "@/components/badge";
import { accessHref, type AccessFilters, type Paged } from "@/lib/data/access-filters";
import type { DirectoryListResult } from "@/lib/data/directory-loaders";
import { formatStaleSince, type SyncState } from "@/lib/data/directory-display";

// Phase 2 — the ONE shell all three Directory list pages render through.
//
// It owns everything that must behave identically across People, Groups and Applications: the header, the search + stale-scope form, the
// six states (forbidden / query failed / too large / not discovered / empty / filtered-empty), the table frame, and pagination. Each page
// supplies only its columns and its copy, so the three pages cannot drift apart in how they describe absence or failure — which is where
// list pages usually start lying.
//
// Markup and classes deliberately match `/access/applications/[id]` so the surfaces read as one product.

export type Column<T> = {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: T) => React.ReactNode;
  readonly className?: string;
};

// The sync badge is the same in all three tables. `stale_since` is only ever shown on a row the loader marked stale — see the note in
// directory-loaders on why a current row's timestamp cannot be trusted.
export function SyncCell({ state, staleSince }: { state: SyncState; staleSince: string | null }) {
  if (state === "current") return <Badge tone="success">Current</Badge>;
  const since = formatStaleSince(staleSince);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="attention">Stale</Badge>
      {since && <span className="text-xs text-zinc-500">last seen {since}</span>}
    </span>
  );
}

export type DirectoryListPageProps<T> = {
  readonly title: string;
  readonly intro: string;
  readonly base: string;                     // e.g. "/directory/people"
  readonly filters: AccessFilters;
  readonly result: DirectoryListResult<T>;
  readonly columns: readonly Column<T>[];
  readonly rowKey: (row: T) => string;
  readonly searchPlaceholder: string;
  readonly noun: string;                     // "people" — used in empty/counting copy
  readonly nounSingular: string;             // "person"
  readonly connectorConfigured: boolean;     // an Okta connector row exists but discovery has not produced records
  readonly footnote?: React.ReactNode;       // page-specific standing explanation (e.g. the SaaS-inventory distinction)
};

const Shell = ({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) => (
  <main className="flex flex-1 flex-col gap-6 p-8">
    <header className="space-y-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">{intro}</p>
    </header>
    {children}
  </main>
);

const Notice = ({ tone = "plain", heading, children }: { tone?: "plain" | "warn"; heading: string; children: React.ReactNode }) => (
  <div
    role="status"
    className={
      tone === "warn"
        ? "max-w-2xl rounded border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950/30"
        : "max-w-2xl rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700"
    }
  >
    <div className="font-medium">{heading}</div>
    <div className="mt-1 text-zinc-600 dark:text-zinc-400">{children}</div>
  </div>
);

export function DirectoryListPage<T>({
  title, intro, base, filters, result, columns, rowKey, searchPlaceholder, noun, nounSingular, connectorConfigured, footnote,
}: DirectoryListPageProps<T>) {
  // Forbidden and query-failed are separate facts and get separate copy. Neither ever renders a database message.
  if (!result.ok) {
    return (
      <Shell title={title} intro={intro}>
        {result.error === "forbidden" ? (
          <Notice heading="Not available">You don’t have access to this area.</Notice>
        ) : (
          <Notice heading="Could not load">Directory data could not be loaded. Please try again later.</Notice>
        )}
      </Shell>
    );
  }

  // Too large: show the bound, never a partial list that would read as the whole directory.
  if (result.data.status === "too_large") {
    return (
      <Shell title={title} intro={intro}>
        <Notice tone="warn" heading="Too large to list in this view">
          This directory contains {result.data.total.toLocaleString()} {noun}, above the current safety limit for this page. No partial list
          is shown, because a truncated list would read as the whole directory. Open a specific record from{" "}
          <Link href="/access" className="underline">Access</Link> to review it.
        </Notice>
      </Shell>
    );
  }

  const { paged, totalBeforeFilter } = result.data;
  const filtered = filters.query !== null;

  // Nothing discovered at all — distinguish "no connector" from "connector configured, discovery has not produced records yet". They call
  // for different actions, and collapsing them into one empty state sends the customer to reconnect something that is already connected.
  if (totalBeforeFilter === 0 && !filtered) {
    return (
      <Shell title={title} intro={intro}>
        {connectorConfigured ? (
          <Notice heading="No records discovered yet">
            A directory connector is configured, but initial discovery has not produced any {noun} yet. Check progress on the{" "}
            <Link href="/connectors/okta/status" className="underline">connector status page</Link>.
          </Notice>
        ) : (
          <Notice heading="No directory connected">
            {title} appear here once a directory is connected and discovered.{" "}
            <Link href="/connectors" className="underline">Connect a directory</Link>.
          </Notice>
        )}
      </Shell>
    );
  }

  return (
    <Shell title={title} intro={intro}>
      {/* A plain GET form: filter state lives in the URL, so a filtered list is shareable and the back button works. No client JS. */}
      <form method="get" action={base} className="flex flex-wrap items-end gap-3 text-sm" aria-label={`Filter ${noun}`}>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-500">Search</span>
          <input
            type="search" name="q" defaultValue={filters.query ?? ""} placeholder={searchPlaceholder}
            className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex items-center gap-2 self-end pb-1.5">
          <input type="checkbox" name="stale" value="1" defaultChecked={filters.includeStale} />
          <span className="text-zinc-500">Include stale records</span>
        </label>
        <button type="submit" className="rounded border border-zinc-400 px-3 py-1.5 font-medium dark:border-zinc-600">Apply</button>
        {(filtered || filters.includeStale) && <Link href={base} className="px-1 py-1.5 text-zinc-500 underline">Clear filters</Link>}
      </form>

      {paged.total === 0 ? (
        <Notice heading={`No ${noun} match your search`}>
          {totalBeforeFilter} {totalBeforeFilter === 1 ? nounSingular : noun} visible to you — adjust the search, or{" "}
          <Link href={base} className="underline">clear it</Link>.
        </Notice>
      ) : (
        <>
          <p className="text-xs text-zinc-500">
            Showing {paged.startIndex}–{paged.endIndex} of {paged.total}{filtered ? " matching" : ""}
            {filters.includeStale ? ", including stale records" : " current"}.
          </p>

          <div className="overflow-x-auto text-sm">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-300 text-zinc-500 dark:border-zinc-700">
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className={`py-2 pr-4 font-medium ${c.className ?? ""}`}>{c.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((row) => (
                  <tr key={rowKey(row)} className="border-b border-zinc-200 dark:border-zinc-800">
                    {columns.map((c) => (
                      <td key={c.key} className={`py-2 pr-4 ${c.className ?? ""}`}>{c.cell(row)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {paged.totalPages > 1 && (
            <nav className="flex items-center gap-3 text-sm" aria-label="Pagination">
              {paged.hasPrev
                ? <Link href={accessHref(base, filters, { page: paged.page - 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">← Previous</Link>
                : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">← Previous</span>}
              <span className="text-zinc-500" aria-current="page">Page {paged.page} of {paged.totalPages}</span>
              {paged.hasNext
                ? <Link href={accessHref(base, filters, { page: paged.page + 1 })} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">Next →</Link>
                : <span className="rounded border border-zinc-200 px-2 py-1 text-zinc-400 dark:border-zinc-800">Next →</span>}
            </nav>
          )}
        </>
      )}

      {footnote && <p className="max-w-3xl text-xs text-zinc-500">{footnote}</p>}
    </Shell>
  );
}

export type { Paged };
