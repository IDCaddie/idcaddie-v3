import type { StatusTone } from "./status-tokens";
import type { MatchRateSummary, DistributionSegment } from "@/lib/data/account-match-summary";

// Dependency-free, server-safe account-coverage visuals (no "use client", no hooks, no data fetch, no chart library).
// Every value is shown as text next to the bar, so nothing relies on color alone. Match COVERAGE only — not UAR.
const SEG_BG: Record<StatusTone, string> = {
  success: "bg-green-500",
  attention: "bg-amber-500",
  danger: "bg-red-500",
  neutral: "bg-zinc-400 dark:bg-zinc-500",
};

// A single matched/unmatched coverage meter: big floored %, a two-segment bar, and the counts as text.
export function MatchRateMeter({ summary, available = true }: { summary: MatchRateSummary; available?: boolean }) {
  if (!available) return <p className="text-sm text-zinc-500">Match status unavailable for these accounts.</p>;
  if (summary.total === 0) return <p className="text-sm text-zinc-500">No accounts to summarize.</p>;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-zinc-500">Match coverage</span>
        <span className="text-2xl font-semibold tabular-nums">{summary.ratePct}%</span>
      </div>
      <div
        className="flex h-3 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
        role="img"
        aria-label={`Matched ${summary.matched} of ${summary.total} accounts (${summary.ratePct}%)`}
      >
        <div className="bg-green-500" style={{ width: `${summary.ratePct}%` }} />
        <div className="bg-zinc-400 dark:bg-zinc-500" style={{ width: `${100 - summary.ratePct}%` }} />
      </div>
      <p className="text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
        <span className="font-semibold">{summary.matched}</span> matched ·{" "}
        <span className="font-semibold">{summary.unmatched}</span> unmatched of {summary.total}
      </p>
    </div>
  );
}

// A generic segmented distribution bar + text legend (label: count). Used for account status (active/inactive/unknown).
export function StatusDistributionBar({
  total,
  segments,
  label,
}: {
  total: number;
  segments: DistributionSegment[];
  label?: string;
}) {
  if (total === 0) return <p className="text-sm text-zinc-500">No account status to summarize.</p>;
  return (
    <div className="space-y-2">
      {label ? <div className="text-sm text-zinc-500">{label}</div> : null}
      <div
        className="flex h-3 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
        role="img"
        aria-label={segments.map((s) => `${s.label}: ${s.count}`).join(", ")}
      >
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <div key={s.key} className={SEG_BG[s.tone]} style={{ width: `${s.pct}%` }} />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${SEG_BG[s.tone]}`} aria-hidden="true" />
            {s.label}: <span className="font-semibold tabular-nums">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
