// Static, server-safe loading placeholders (no "use client", no hooks, no data, no links). The pulsing blocks are
// decorative (aria-hidden); PageSkeleton carries a single visible-to-assistive-tech "Loading…" status. No real data,
// no counts, no ids — just shape.
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-zinc-200 dark:bg-zinc-800 ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div aria-hidden="true" className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <SkeletonBlock className="h-3 w-20" />
      <SkeletonBlock className="h-7 w-16" />
    </div>
  );
}

export function SkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      <div className="flex gap-4">
        {Array.from({ length: cols }, (_, i) => (
          <SkeletonBlock key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => (
            <SkeletonBlock key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

// Full-page loading fallback: a title/subtitle placeholder + optional stat-card grid + optional table, and one
// visible-to-screen-reader "Loading…" status so the state is announced.
export function PageSkeleton({ cards = 0, table = true }: { cards?: number; table?: boolean }) {
  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <span role="status" className="sr-only">
        Loading…
      </span>
      <div className="space-y-2">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-3 w-72" />
      </div>
      {cards > 0 ? <SkeletonGrid count={cards} /> : null}
      {table ? <SkeletonTable /> : null}
    </main>
  );
}
