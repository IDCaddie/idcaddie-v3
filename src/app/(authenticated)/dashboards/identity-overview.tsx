import Link from "next/link";
import type { AccessOverviewData } from "@/lib/data/access-loaders";

// Phase 1 — the identity-first lead of Home.
//
// Every number here comes from `loadAccessOverview`, the same loader that powers /access. Nothing is recomputed and nothing is
// invented: if the graph could not be evaluated within safety limits the loader returns `too_large`, and this renders the counts
// it does have rather than a confident-looking zero.
//
// This block sits ABOVE the SaaS summary deliberately. The customer's first question after connecting a directory is "who is in
// here and what can they reach", not "what do we spend" — and the previous Home led with "App-user accounts visible: 0", which
// is true for a directory-only tenant and reads as an empty product.

function Stat({ label, value, href, tone }: { label: string; value: number | string; href?: string; tone?: "critical" }) {
  const body = (
    <>
      <div className={`text-2xl font-semibold tabular-nums ${tone === "critical" && value !== 0 ? "text-red-700 dark:text-red-400" : ""}`}>{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
    </>
  );
  const cls = "rounded-lg border border-zinc-200 p-3 dark:border-zinc-800";
  return href
    ? <Link href={href} className={`${cls} block transition-colors hover:border-zinc-400 dark:hover:border-zinc-600`}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

export function IdentityOverview({ data }: { data: AccessOverviewData | null }) {
  if (!data) {
    // No directory yet — say what to do about it instead of rendering six zeros, which look like failure rather than absence.
    return (
      <section aria-labelledby="identity-heading" className="space-y-3">
        <h2 id="identity-heading" className="text-sm font-medium">Identity and access</h2>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No directory has been discovered yet.</p>
          <Link href="/connectors" className="mt-2 inline-block text-sm underline">Connect a directory</Link>
        </div>
      </section>
    );
  }

  const c = data.counts;
  const high = data.status === "complete" ? (data.summary.bySeverity.high ?? 0) : null;

  return (
    <section aria-labelledby="identity-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="identity-heading" className="text-sm font-medium">Identity and access</h2>
        <Link href="/access" className="text-xs underline">Open Access</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {/* Phase 2: the three directory counts open the list that produced them, not the Access report. The graph-derived numbers below
            still open Access, because that is where they are computed and explained. */}
        <Stat label="People" value={c.identities} href="/directory/people" />
        <Stat label="Groups" value={c.groups} href="/directory/groups" />
        <Stat label="Directory applications" value={c.applications} href="/directory/applications" />
        {data.status === "complete" ? (
          <>
            <Stat label="Effective access" value={data.effectiveRelationships} href="/access" />
            <Stat label="Through group only" value={data.breakdown.groupOnly} href="/access" />
            <Stat label="High findings" value={high ?? 0} href="/access/findings?severity=high" tone="critical" />
          </>
        ) : (
          <>
            <Stat label="Group memberships" value={c.memberships} href="/directory/groups" />
            <Stat label="Direct assignments" value={c.directAssignments} href="/access" />
            <Stat label="Group assignments" value={c.groupAssignments} href="/access" />
          </>
        )}
      </div>

      {data.status === "complete" && data.breakdown.groupOnly > 0 && (
        // The single most useful sentence on the page: access nobody granted directly. Stated once, in plain language.
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {data.breakdown.groupOnly} of {data.effectiveRelationships} effective relationships exist only through group
          membership — access granted by joining a group rather than by direct assignment.
        </p>
      )}
      {data.status === "too_large" && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          The full access graph was not evaluated within current safety limits, so effective access and findings are not shown
          here. Directory counts above are complete.
        </p>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Counts reflect current directory evidence. Records last seen in an earlier discovery are marked stale and excluded.
      </p>
    </section>
  );
}
