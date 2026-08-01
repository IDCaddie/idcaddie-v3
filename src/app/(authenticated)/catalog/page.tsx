import Link from "next/link";
import { listCatalogForCurrentUser } from "@/lib/data/catalog";
import { DEMO_MODE } from "@/app/(authenticated)/nav-items";
import {
  buildCatalog,
  summarizeCatalog,
  isCatalogFilter,
  type CatalogFilter,
} from "@/lib/data/catalog-view";

export const metadata = { title: "App Catalog · ID Caddie" };

// Read-only App Catalog: the canonical vendor → product → alias graph the resolver uses to normalize the SaaS
// inventory. Renders only the RLS-scoped rows the user may read (0024 `members read`); search/filter run
// server-side over those rows (no new query, no client tenant filter). Safe projection only — no
// normalized_name/source/provenance/reviewed_by/tenant_id/raw ids as data. No writes/sync/AI.
const NOT_BUILT = ["Confirm / reject alias", "Merge / unmerge product", "Run resolver", "Export"];

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const filter: CatalogFilter | undefined =
    typeof sp.filter === "string" && isCatalogFilter(sp.filter) ? sp.filter : undefined;

  const result = await listCatalogForCurrentUser();
  const summary = result.ok ? summarizeCatalog(result.data) : null;
  const groups = result.ok ? buildCatalog(result.data, { q, filter }) : [];
  const totalEntries = result.ok ? result.data.vendors.length + result.data.products.length : 0;

  const hrefWith = (f?: CatalogFilter) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (f && f !== filter) params.set("filter", f); // clicking the active filter clears it
    const s = params.toString();
    return s ? `/catalog?${s}` : "/catalog";
  };
  const pill = (active: boolean) =>
    `rounded-full border px-2 py-0.5 text-xs ${active ? "border-amber-500 text-amber-700 dark:text-amber-400" : "border-zinc-300 text-zinc-500 dark:border-zinc-700"}`;
  const FILTER_LABELS: [CatalogFilter, string][] = [
    ["vendors_with_products", "Vendors with products"],
    ["products_with_aliases", "Products with aliases"],
    ["products_without_aliases", "Products without aliases"],
  ];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">App Catalog</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Canonical vendors and products used to keep your SaaS inventory consistent.
        </p>
      </header>

      {!result.ok ? (
        <p className="text-sm text-red-600">Could not load the catalog right now. Please try again later.</p>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Vendors" value={summary!.vendorCount} />
            <Stat label="Products" value={summary!.productCount} />
            <Stat label="Aliases" value={summary!.aliasCount} />
            <Stat label="Aliases pending review" value={summary!.aliasesByReviewStatus.pending} />
          </section>

          {totalEntries > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <form method="get" action="/catalog" className="flex gap-2">
                <input
                  type="search"
                  name="q"
                  defaultValue={q}
                  placeholder="Search vendor, product, or alias"
                  className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
                {filter ? <input type="hidden" name="filter" value={filter} /> : null}
                <button type="submit" className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">
                  Search
                </button>
              </form>
              <span className="text-zinc-500">Filter:</span>
              {FILTER_LABELS.map(([f, label]) => (
                <Link key={f} href={hrefWith(f)} className={pill(filter === f)}>
                  {label}
                </Link>
              ))}
              {q || filter ? (
                <Link href="/catalog" className="text-xs text-zinc-500 underline">
                  clear
                </Link>
              ) : null}
            </div>
          ) : null}

          {totalEntries === 0 ? (
            <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <div className="font-medium">No catalog entries yet.</div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                No catalog records yet.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded border border-zinc-300 p-4 text-sm dark:border-zinc-700">
              <div className="font-medium">No catalog entries match your search/filters</div>
              <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                Adjust the search or filters above, or{" "}
                <Link href="/catalog" className="underline">
                  clear them
                </Link>
                .
              </p>
            </div>
          ) : (
            <section className="space-y-4 text-sm">
              {groups.map((vendor) => (
                <div key={vendor.id ?? "no-vendor"} className="rounded border border-zinc-200 p-4 dark:border-zinc-800">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="font-medium">{vendor.name}</h2>
                    {vendor.websiteDomain ? <span className="text-xs text-zinc-500">{vendor.websiteDomain}</span> : null}
                    <span className="text-xs text-zinc-500">
                      · {vendor.productCount} product{vendor.productCount === 1 ? "" : "s"} · {vendor.aliasCount} alias
                      {vendor.aliasCount === 1 ? "" : "es"}
                    </span>
                  </div>
                  {vendor.products.length === 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">No products.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {vendor.products.map((p) => (
                        <li key={p.id} className="border-t border-zinc-100 pt-2 dark:border-zinc-800/60">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="font-medium">{p.name}</span>
                            {p.category ? <span className="text-xs text-zinc-500">{p.category}</span> : null}
                            <span className="text-xs text-zinc-500">
                              · {p.aliasCount} alias{p.aliasCount === 1 ? "" : "es"}
                            </span>
                          </div>
                          {p.aliases.length > 0 ? (
                            <ul className="mt-1 flex flex-wrap gap-2">
                              {p.aliases.map((a) => (
                                <li
                                  key={a.id}
                                  className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                                  title={`${a.aliasType} · ${a.reviewStatus}`}
                                >
                                  {a.aliasValue}
                                  <span className="ml-1 text-[10px] text-zinc-400">{a.reviewStatus}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )}

          {!DEMO_MODE && (
            <section className="space-y-2 text-sm">
              <h2 className="font-medium">Catalog actions</h2>
              <p className="text-xs text-zinc-500">
                Alias review and product merges are managed by ID Caddie — listed here so the scope is
                explicit. This surface is read-only.
              </p>
              <ul className="flex flex-wrap gap-2">
                {NOT_BUILT.map((label) => (
                  <li key={label}>
                    <span
                      aria-disabled="true"
                      title="Not built yet"
                      className="inline-flex items-center gap-2 rounded border border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700"
                    >
                      {label}
                      <span className="rounded-full border border-zinc-300 px-1.5 text-[10px] dark:border-zinc-700">
                        Not built yet
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
