import Link from "next/link";
import type { ReactNode } from "react";
import type { StatusTone } from "./status-tokens";

// Presentational, server-safe stat tile (no "use client", no hooks, no data). One canonical StatCard so the overview
// pages stop hand-rolling divergent stat markup. Works for counts, money strings, percentages, and short labels.
// null/undefined value → "—". href makes the whole card a link (adds an "Open →" affordance). tone colors the value
// using the shared status language (default neutral = no color).
const TONE_VALUE: Record<StatusTone, string> = {
  success: "text-green-700 dark:text-green-400",
  attention: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
  neutral: "",
};

export function StatCard({
  label,
  value,
  sub,
  href,
  tone = "neutral",
}: {
  label: string;
  value: string | number | null | undefined;
  sub?: string;
  href?: string;
  tone?: StatusTone;
}) {
  const body = (
    <>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${TONE_VALUE[tone]}`}>{value ?? "—"}</div>
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
      {href ? <div className="mt-2 text-xs text-zinc-500 underline">Open →</div> : null}
    </>
  );
  const base = "rounded border border-zinc-200 p-4 dark:border-zinc-800";
  return href ? (
    <Link href={href} className={`${base} block transition hover:border-zinc-400 dark:hover:border-zinc-600`}>
      {body}
    </Link>
  ) : (
    <div className={base}>{body}</div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</section>;
}
