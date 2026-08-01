import Link from "next/link";
import { Badge } from "@/components/badge";
import type { AttentionRow, HealthRollup, Posture, RiskBreakdown } from "@/lib/data/executive-home";
import type { ConnectorSummary } from "@/lib/data/connector-management";

// Phase 7A — the executive Home panels. Presentation only; every value arrives already derived.

const TONE: Record<string, "success" | "attention" | "danger" | "neutral"> = {
  healthy: "success", pending: "attention", attention: "attention", failed: "danger", inactive: "neutral",
  high: "danger", medium: "attention", low: "neutral", info: "neutral",
};

export function Section({ id, title, action, children }: { id: string; title: string; action?: { label: string; href: string }; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        {action && <Link href={action.href} className="text-xs underline text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">{action.label}</Link>}
      </div>
      {children}
    </section>
  );
}

export function Metric({ label, value, href, sub, tone }: { label: string; value: number | string; href?: string; sub?: string; tone?: "danger" }) {
  const body = (
    <>
      <div className={`text-2xl font-semibold tabular-nums ${tone === "danger" && value !== 0 ? "text-red-700 dark:text-red-400" : ""}`}>{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-400">{sub}</div>}
    </>
  );
  const cls = "rounded-lg border border-zinc-200 p-3 dark:border-zinc-800";
  return href
    ? <Link href={href} className={`${cls} block transition-colors hover:border-zinc-400 dark:hover:border-zinc-600`}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

// ── Access posture ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// A segmented bar over the engine's own breakdown. No new calculation, and the legend carries the numbers so the chart is not
// the only way to read it.
export function AccessPosture({ p, scopeQuery }: { p: Posture; scopeQuery: string }) {
  if (p.status === "unavailable") {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {p.reason === "forbidden" ? "You don’t have access to effective-access data." : "Effective access could not be loaded. This is not a statement that none exists."}
      </p>
    );
  }
  if (p.status === "too_large") {
    // Zeros here would be a false all-clear: the graph was never evaluated, so nothing is known about its shape.
    return (
      <div role="status" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30">
        <div className="font-medium">Access distribution not evaluated</div>
        <p className="mt-1 text-zinc-700 dark:text-zinc-300">
          This directory is above the current safety limit for whole-graph evaluation, so how access is granted is not shown. The
          directory counts above remain accurate. Open a specific person or application to review their access individually.
        </p>
      </div>
    );
  }

  const segs = [
    { key: "groupOnly", label: "Through group only", n: p.groupOnly, cls: "bg-indigo-500" },
    { key: "both", label: "Direct and through group", n: p.both, cls: "bg-amber-500" },
    { key: "directOnly", label: "Direct only", n: p.directOnly, cls: "bg-zinc-400 dark:bg-zinc-500" },
  ];
  const total = p.effective;

  if (total === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">No effective application access is represented in this directory yet.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full" role="img"
           aria-label={`Effective access by path: ${segs.map((s) => `${s.label} ${s.n}`).join(", ")}, ${total} total`}>
        {segs.filter((s) => s.n > 0).map((s) => (
          <div key={s.key} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} />
        ))}
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {segs.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${s.cls}`} aria-hidden />
            <dt className="text-zinc-500">{s.label}</dt>
            <dd className="tabular-nums font-medium">{s.n}</dd>
          </div>
        ))}
      </dl>
      {p.groupOnly > 0 && (
        <p className="text-xs text-zinc-500">
          {p.groupOnly} of {total} effective relationships exist only through group membership — access granted by joining a group
          rather than by direct assignment.
        </p>
      )}
      <Link href={`/access${scopeQuery}`} className="inline-block text-xs underline">Open Access</Link>
    </div>
  );
}

// ── Risk ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function RiskPanel({ r, scopeQuery }: { r: RiskBreakdown; scopeQuery: string }) {
  const f = (sev: string) => `/access/findings?severity=${sev}${scopeQuery ? `&${scopeQuery.slice(1)}` : ""}`;
  if (r.total === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">No governance findings for this directory. Findings are produced from access topology, so an empty result means nothing matched — not that nothing was checked.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric label="High" value={r.high} href={f("high")} tone="danger" />
        <Metric label="Medium" value={r.medium} href={f("medium")} />
        <Metric label="Stale evidence" value={r.staleEvidence} href={`/access/findings?staleEvidence=1${scopeQuery ? `&${scopeQuery.slice(1)}` : ""}`} />
      </div>
      {r.topSubjects.length > 0 && (
        <ul className="space-y-1.5 text-sm">
          {/* Only findings with a resolved subject: a row the customer cannot follow is not a priority, it is a dead end. */}
          {r.topSubjects.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[s.severity] ?? "neutral"}>{s.severityLabel}</Badge>
              <Link href={s.subject!.href} className="underline-offset-2 hover:underline">{s.subject!.label}</Link>
              <span className="text-xs text-zinc-500">{s.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Connector and evidence health ────────────────────────────────────────────────────────────────────────────────────────────
export function HealthPanel({ rollup, connectors, stale }: { rollup: HealthRollup | null; connectors: readonly ConnectorSummary[]; stale: number | null }) {
  if (!rollup) return <p className="text-sm text-zinc-600 dark:text-zinc-400">No active directory.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[rollup.state] ?? "neutral"}>{rollup.label}</Badge>
        <span className="text-xs text-zinc-500">{rollup.reason}</span>
      </div>

      {/* In all-active mode a per-connector list is mandatory: one green badge over several directories would hide a failure. */}
      {connectors.length > 1 && (
        <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {connectors.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <Link href={`/connectors/manage/${c.id}`} className="font-medium underline-offset-2 hover:underline">{c.name}</Link>
                <Badge tone={TONE[c.health.state] ?? "neutral"}>{c.health.label}</Badge>
              </span>
              <span className="text-xs tabular-nums text-zinc-500">
                {c.counts.people} people · {c.counts.groups} groups · {c.counts.applications} apps
              </span>
            </li>
          ))}
        </ul>
      )}

      {stale !== null && stale > 0 && (
        <p className="text-xs text-zinc-500">
          {stale} retained stale {stale === 1 ? "record" : "records"} — last seen in an earlier discovery, kept as evidence and
          excluded from the active counts above.
        </p>
      )}
    </div>
  );
}

// ── Needs attention ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function AttentionPanel({ rows }: { rows: readonly AttentionRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Nothing needs attention in this directory right now.</p>;
  }
  return (
    <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[r.severity] ?? "neutral"}>{r.badge}</Badge>
              <span className="font-medium">{r.title}</span>
              {r.subject && <span className="text-xs text-zinc-500">· {r.subject}</span>}
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">{r.detail}</p>
          </div>
          <Link href={r.href} className="shrink-0 text-xs underline">{r.actionLabel}</Link>
        </li>
      ))}
    </ul>
  );
}
