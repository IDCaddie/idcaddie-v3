import Link from "next/link";
import { Badge } from "@/components/badge";
import { parseAccessFilters, returnParams, type SearchParamsInput } from "@/lib/data/access-filters";
import { loadDirectoryApplications, type DirectoryApplicationRow } from "@/lib/data/directory-loaders";
import { appStatusLabel, signOnLabel } from "@/lib/data/directory-display";
import { getOktaConnectorStatus } from "@/lib/data/okta-connector-status";
import { DirectoryListPage, SyncCell, type Column } from "../directory-list-page";

export const metadata = { title: "Directory applications · ID Caddie" };

// Applications the IDENTITY PROVIDER exposes — sourced from `directory_applications`. This is a different model from `public.apps`, which
// holds normalized software records for contracts and spend, and the two are never joined here. There is no FK between them and no matcher
// has run; conflating them would attach a contract to an application nobody verified is the same product.

export default async function DirectoryApplicationsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const [result, okta] = await Promise.all([
    loadDirectoryApplications(filters),
    getOktaConnectorStatus().catch(() => null),
  ]);

  const detailHref = (id: string) => `/access/applications/${id}?${returnParams("applications", filters).toString()}`;

  const columns: readonly Column<DirectoryApplicationRow>[] = [
    {
      key: "name",
      header: "Application",
      cell: (a) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Link href={detailHref(a.id)} className="font-medium underline-offset-2 hover:underline">{a.name}</Link>
          {/* Only rendered when a real match exists. Nothing writes catalog_match_status today, so every row would otherwise carry an
              "Unmatched" chip that reads as a defect rather than as work that has not started. */}
          {a.catalogMatch && <Badge tone="success">Catalog match</Badge>}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (a) => {
        const label = appStatusLabel(a.statusCategory);
        if (label === null) return <span className="text-zinc-400">—</span>;
        return <Badge tone={a.statusCategory === "active" ? "success" : "neutral"}>{label}</Badge>;
      },
    },
    {
      key: "signon",
      header: "Sign-on",
      cell: (a) => signOnLabel(a.signOnCategory) ?? <span className="text-zinc-400">—</span>,
    },
    { key: "sync", header: "Directory record", cell: (a) => <SyncCell state={a.syncState} staleSince={a.staleSince} /> },
    {
      key: "action",
      header: "",
      className: "text-right",
      cell: (a) => <Link href={detailHref(a.id)} className="underline">View access</Link>,
    },
  ];

  return (
    <DirectoryListPage
      title="Directory applications"
      intro="Applications discovered from your identity provider, and who can reach each one. Open an application to see the people with access and whether they got it directly or through a group."
      base="/directory/applications"
      filters={filters}
      result={result}
      columns={columns}
      rowKey={(a) => a.id}
      searchPlaceholder="Application name"
      noun="applications"
      nounSingular="application"
      connectorConfigured={okta !== null}
      footnote={
        <>
          Directory applications are what your identity provider exposes.{" "}
          <Link href="/apps" className="underline">SaaS inventory</Link> is a separate surface holding normalized software records used for
          contracts, spend and utilization. An application listed here is not automatically linked to a SaaS record. Whether a particular
          application still needs review or linking is decided by cross-system governance, not by its presence in this list.
        </>
      }
    />
  );
}
