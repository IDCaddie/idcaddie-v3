import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/badge";

// Shared chrome for the SaaS evidence surfaces. Server-safe (no "use client", no hooks): search and filters are plain
// GET forms, so the page works with JavaScript still loading and the browser back button behaves.

export function Shell({ title, intro, actions, children }: { title: string; intro: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{intro}</p>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Notice({ heading, tone = "neutral", children }: { heading: string; tone?: "neutral" | "warn"; children: ReactNode }) {
  const cls = tone === "warn"
    ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40"
    : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40";
  return (
    <div className={`rounded-lg border p-5 ${cls}`}>
      <div className="font-medium">{heading}</div>
      <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">{children}</div>;
}

// Evidence freshness. `Current` means the most recent completed sync saw this record; `Not seen recently` means it did
// not. Deliberately NOT called "stale" in the interface — the customer-facing question is "was this confirmed", and
// nothing here is ever deleted, so "stale" reads as data loss when it means the opposite.
export function EvidenceCell({ syncStatus, staleSince }: { syncStatus: string; staleSince: string | null }) {
  if (syncStatus === "current") return <Badge tone="success">Current</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="attention">Not seen recently</Badge>
      {staleSince ? <span className="text-xs text-zinc-500">since {formatDate(staleSince)}</span> : null}
    </span>
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Offset pagination as links, so a page is shareable and the back button works.
export function Pager({ base, params, offset, limit, total }: {
  base: string; params: URLSearchParams; offset: number; limit: number; total: number;
}) {
  if (total <= limit) return null;
  const mk = (o: number) => { const p = new URLSearchParams(params); p.set("offset", String(Math.max(0, o))); return `${base}?${p.toString()}`; };
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
      <span className="text-zinc-500">Showing {from}–{to} of {total.toLocaleString()}</span>
      <span className="flex gap-3">
        {offset > 0
          ? <Link href={mk(offset - limit)} className="underline">← Previous</Link>
          : <span className="text-zinc-400">← Previous</span>}
        {to < total
          ? <Link href={mk(offset + limit)} className="underline">Next →</Link>
          : <span className="text-zinc-400">Next →</span>}
      </span>
    </div>
  );
}
