import Link from "next/link";
import { Badge } from "@/components/badge";
import { accessHref, parseAccessFilters, type SearchParamsInput } from "@/lib/data/access-filters";
import { loadDirectoryGroups, type DirectoryGroupRow } from "@/lib/data/directory-loaders";
import { groupTypeLabel } from "@/lib/data/directory-display";
import { getOktaConnectorStatus } from "@/lib/data/okta-connector-status";
import { DirectoryListPage, SyncCell, type Column } from "../directory-list-page";

export const metadata = { title: "Groups · ID Caddie" };

// Groups discovered from the identity provider. There is NO group detail route and no group access subgraph RPC — migration 0061 provides
// identity and application subgraphs only. So this page does not pretend to open a group; the one real destination a group name has today
// is the governance findings filtered to that group, which is a working query, not a placeholder.

export default async function DirectoryGroupsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const [result, okta] = await Promise.all([
    loadDirectoryGroups(filters),
    getOktaConnectorStatus().catch(() => null),
  ]);

  // Findings carry a subject type and a searchable subject label, so this lands on the real findings for this group rather than a stub.
  const findingsHref = (name: string) =>
    accessHref("/access/findings", filters, { query: name.toLowerCase(), subjectType: "group", page: 1, includeStale: filters.includeStale });

  const columns: readonly Column<DirectoryGroupRow>[] = [
    {
      key: "name",
      header: "Group",
      cell: (g) => <span className="font-medium">{g.name}</span>,
    },
    {
      key: "type",
      header: "Type",
      // Built-in groups are provider-managed and cannot be edited. "Everyone" granting access to an application is a materially different
      // fact from a group someone deliberately created, so it is toned to stand out — in the Type column, where the type belongs, rather
      // than duplicated as a second chip beside the name.
      cell: (g) => {
        const label = groupTypeLabel(g.typeCategory);
        if (label === null) return <span className="text-zinc-400">—</span>;
        return <Badge tone={g.isBuiltIn ? "attention" : "neutral"}>{label}</Badge>;
      },
    },
    { key: "sync", header: "Directory record", cell: (g) => <SyncCell state={g.syncState} staleSince={g.staleSince} /> },
    {
      key: "action",
      header: "",
      className: "text-right",
      cell: (g) => <Link href={findingsHref(g.name)} className="underline">View findings</Link>,
    },
  ];

  return (
    <DirectoryListPage
      title="Groups"
      intro="Groups discovered from your identity provider. Group membership is one of the two ways a person gets access to an application — the other is a direct assignment."
      base="/directory/groups"
      filters={filters}
      result={result}
      columns={columns}
      rowKey={(g) => g.id}
      searchPlaceholder="Group name"
      noun="groups"
      nounSingular="group"
      connectorConfigured={okta !== null}
      footnote={
        <>
          Member counts and the applications a group grants are not shown here yet, and a group has no detail page of its own. Both are
          reachable today from the other direction: open a person or an application on{" "}
          <Link href="/access" className="underline">Access</Link> to see the groups involved in their access.
        </>
      }
    />
  );
}
