import Link from "next/link";
import { Badge } from "@/components/badge";
import { parseAccessFilters, returnParams, type SearchParamsInput } from "@/lib/data/access-filters";
import { loadDirectoryPeople, type PersonRow } from "@/lib/data/directory-loaders";
import { getOktaConnectorStatus } from "@/lib/data/okta-connector-status";
import { DirectoryListPage, SyncCell, type Column } from "../directory-list-page";

export const metadata = { title: "People · ID Caddie" };

// People discovered from the identity provider — NOT `app_users`, which is the SaaS-management model of per-application account records.
// The two are different tables answering different questions and this page never touches the second one.

export default async function DirectoryPeoplePage({ searchParams }: { searchParams: Promise<SearchParamsInput> }) {
  const sp = await searchParams;
  const filters = parseAccessFilters(sp);
  const [result, okta] = await Promise.all([
    loadDirectoryPeople(filters),
    getOktaConnectorStatus().catch(() => null),
  ]);

  // Carrying the current filter state into the detail page lets "back" return to the same page of the same search.
  const detailHref = (id: string) => `/access/identities/${id}?${returnParams("people", filters).toString()}`;

  const columns: readonly Column<PersonRow>[] = [
    {
      key: "name",
      header: "Name",
      cell: (p) => (
        <Link href={detailHref(p.id)} className="font-medium underline-offset-2 hover:underline">{p.name}</Link>
      ),
    },
    {
      key: "identifier",
      header: "Identifier",
      // Only rendered when it differs from the displayed name — otherwise this column would repeat the one beside it, since the name
      // itself already falls back to login and then email.
      cell: (p) => p.secondaryId ? <span className="text-zinc-600 dark:text-zinc-400">{p.secondaryId}</span> : <span className="text-zinc-400">—</span>,
    },
    {
      key: "active",
      header: "Account",
      // `is_active` is a bounded boolean. The provider's raw `status` string is deliberately not shown: it carries unmapped Okta lifecycle
      // tokens (PROVISIONED, PASSWORD_EXPIRED, …) that mean nothing to a customer and have no CHECK-constrained vocabulary.
      cell: (p) => p.isActive === null
        ? <span className="text-zinc-400">—</span>
        : <Badge tone={p.isActive ? "success" : "neutral"}>{p.isActive ? "Active" : "Inactive"}</Badge>,
    },
    { key: "sync", header: "Directory record", cell: (p) => <SyncCell state={p.syncState} staleSince={p.staleSince} /> },
    {
      key: "action",
      header: "",
      className: "text-right",
      cell: (p) => <Link href={detailHref(p.id)} className="underline">View access</Link>,
    },
  ];

  return (
    <DirectoryListPage
      title="People"
      intro="People discovered from your identity provider, with the groups they belong to and the applications they can reach. Open a person to see their effective access."
      base="/directory/people"
      filters={filters}
      result={result}
      columns={columns}
      rowKey={(p) => p.id}
      searchPlaceholder="Name, login or email"
      noun="people"
      nounSingular="person"
      connectorConfigured={okta !== null}
      footnote="Group memberships and effective application counts are shown on each person’s access page. They are not summarized in this list because doing so would require loading the full access graph on every page view."
    />
  );
}
