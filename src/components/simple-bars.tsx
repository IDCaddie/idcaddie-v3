import Link from "next/link";
import { Badge } from "./badge";
import type { StatusTone } from "./status-tokens";
import type { SpendBarSegment, RenewalSegmentSummary, UpcomingRenewalRow } from "@/lib/data/dashboard-charts";

// Dependency-free, server-safe dashboard visuals (no "use client", no hooks, no data fetch, NO chart library).
// Every bar is a Tailwind <div> width%; the numbers/labels are always shown as text so nothing relies on color alone.
const SEG_BG: Record<StatusTone, string> = {
  success: "bg-green-500",
  attention: "bg-amber-500",
  danger: "bg-red-500",
  neutral: "bg-zinc-400 dark:bg-zinc-500",
};

// Horizontal value bars per currency (width relative to the largest). Amount + contract count shown as text.
export function SpendBars({ segments }: { segments: SpendBarSegment[] }) {
  if (segments.length === 0) return <p className="text-sm text-zinc-500">No tracked contract spend yet.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {segments.map((s) => (
        <li key={s.currency} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 tabular-nums">
            <span className="font-semibold">{s.label}</span>
            <span className="text-xs text-zinc-500">
              {s.contractCount} contract{s.contractCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full rounded bg-zinc-400 dark:bg-zinc-500" style={{ width: `${s.widthPct}%` }} aria-hidden="true" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// One segmented bar for renewal urgency + a text legend (label: count) so it reads without color.
export function RenewalSegmentBar({ summary }: { summary: RenewalSegmentSummary }) {
  if (summary.total === 0) return <p className="text-sm text-zinc-500">No dated renewals to summarize.</p>;
  return (
    <div className="space-y-2">
      <div
        className="flex h-3 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
        role="img"
        aria-label={summary.segments.map((s) => `${s.label}: ${s.count}`).join(", ")}
      >
        {summary.segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <div key={s.key} className={SEG_BG[s.tone]} style={{ width: `${s.pct}%` }} />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {summary.segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${SEG_BG[s.tone]}`} aria-hidden="true" />
            {s.label}: <span className="font-semibold tabular-nums">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Ranked upcoming renewals with an urgency Badge + link to the contract (same data the dashboard already had).
export function UpcomingRenewalRows({ rows }: { rows: UpcomingRenewalRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-zinc-500">No upcoming renewals.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2">
          <Badge tone={r.tone}>{r.urgencyLabel}</Badge>
          <Link href={`/contracts/${r.id}`} className="underline">
            {r.contractName}
          </Link>
          <span className="text-zinc-500">
            — {r.date}
            {r.basis === "end" ? " (end date)" : ""}
            {r.noticeDeadline ? `, notice by ${r.noticeDeadline}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
