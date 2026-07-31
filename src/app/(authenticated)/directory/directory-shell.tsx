import Link from "next/link";
import { loadAccessOverview } from "@/lib/data/access-loaders";

// Phase 1 route shell for a Directory list page.
//
// These exist so the Directory section is a REAL part of the information architecture rather than three disabled labels. Each
// one is honest about being a shell, states the live count from the graph, and routes to the place that data is reachable
// today — the Access report, where person and application detail already work in full.
//
// It is deliberately NOT a stub that says only "coming soon": a customer landing here still learns how many records exist and
// where to go. The list views themselves land in Phase 2.

type Kind = "people" | "groups" | "applications";

const COPY: Record<Kind, { title: string; blurb: string; countLabel: string }> = {
  people: {
    title: "People",
    blurb: "Every identity discovered from your connected directory, with their groups, assignments and effective access.",
    countLabel: "people discovered",
  },
  groups: {
    title: "Groups",
    blurb: "Every directory group, who belongs to it, and the applications membership grants access to.",
    countLabel: "groups discovered",
  },
  applications: {
    title: "Applications",
    blurb: "Applications discovered from your identity provider, and who can reach each one. Separate from SaaS inventory, which holds normalized software records used for contracts and spend.",
    countLabel: "directory applications discovered",
  },
};

export async function DirectoryShell({ kind }: { kind: Kind }) {
  const r = await loadAccessOverview();
  const data = r.ok ? r.data : null;
  const count = data
    ? kind === "people" ? data.counts.identities : kind === "groups" ? data.counts.groups : data.counts.applications
    : null;
  const c = COPY[kind];

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{c.title}</h1>
        <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{c.blurb}</p>
      </header>

      <div className="max-w-2xl space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        {count === null ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No directory has been discovered yet. <Link href="/connectors" className="underline">Connect a directory</Link> to populate this page.
          </p>
        ) : (
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            <span className="text-2xl font-semibold tabular-nums">{count}</span>{" "}
            <span className="text-zinc-500 dark:text-zinc-400">{c.countLabel}</span>
          </p>
        )}
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The {c.title.toLowerCase()} list view is in progress. This data is reachable today on Access, where{" "}
          {kind === "groups" ? "group membership and group-granted access are shown per person and per application" : `each ${kind === "people" ? "person" : "application"} has a full detail view`}.
        </p>
        <Link href="/access" className="inline-flex items-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          Open Access
        </Link>
      </div>
    </main>
  );
}
