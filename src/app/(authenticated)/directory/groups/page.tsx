import Link from "next/link";
import { Badge } from "@/components/badge";
import { accessHref, parseAccessFilters, returnParams, type SearchParamsInput } from "@/lib/data/access-filters";
import { loadDirectoryGroups, type DirectoryGroupRow } from "@/lib/data/directory-loaders";
import { groupTypeLabel } from "@/lib/data/directory-display";
import { getOktaConnectorStatus } from "@/lib/data/okta-connector-status";
import { DirectoryListPage, SyncCell, type Column } from "../directory-list-page";

export const metadata = { title: "Groups · ID Caddie" };

// Groups discovered from the identity provider. Phase 3 gave groups a real detail route backed by `product_group_access_subgraph`
// (migration 0072), so the group name now opens the group itself. Findings remains as a secondary action for the case where the
// customer wants the governance view directly.

export default async function DirectoryGroupsPage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const [result, okta] = await Promise.all([
    loadDirectoryGroups(filters),
    getOktaConnectorStatus().catch(() => null),
  ]);

  // The group name opens the group. Filter state rides along so "← Groups" returns to the same page of the same search.
  const detailHref = (id: string) => `/directory/groups/${id}?${returnParams("groups", filters).toString()}`;

  // Secondary action. Findings carry a subject type and a searchable subject label, so this lands on the real findings for this group.
  const findingsHref = (name: string) =>
    accessHref("/access/findings", filters, { query: name.toLowerCase(), subjectType: "group", page: 1, includeStale: filters.includeStale });

  const columns: readonly Column<DirectoryGroupRow>[] = [
    {
      key: "name",
      header: "Group",
      cell: (g) => <Link href={detailHref(g.id)} className="font-medium underline-offset-2 hover:underline">{g.name}</Link>,
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
          Member and application counts are not shown in this list: each would require loading the full membership and assignment
          tables on every page view. Open a group to see its members, the applications it grants, and which of those its members
          would still hold without it.
        </>
      }
    />
  );
}
