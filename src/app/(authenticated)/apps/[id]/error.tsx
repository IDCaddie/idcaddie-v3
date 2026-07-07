"use client";
import Link from "next/link";

// Error boundary for the app-detail route. Renders ONLY safe static copy + the Next-generated `digest`
// (a log-correlation hash, not the message/stack) — never error.message, which could leak internals. Not-found
// is handled inline by the page (RLS-hidden id → generic "not found"), so no not-found.tsx is needed here.
export default function AppDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex flex-1 flex-col gap-4 p-8 text-sm">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        This app couldn’t be displayed right now. No details are shown for safety.
      </p>
      {error.digest ? <p className="text-xs text-zinc-500">Reference: {error.digest}</p> : null}
      <div className="flex gap-3">
        <button onClick={reset} className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
          Try again
        </button>
        <Link href="/apps" className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
          Back to apps
        </Link>
      </div>
    </main>
  );
}
