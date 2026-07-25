"use client";
import Link from "next/link";

// Error boundary for the access surface. Renders ONLY safe static copy + the Next-generated `digest` (never message/stack). Not-found is
// handled inline by each page (RLS/RPC-hidden id -> generic not found), so no not-found.tsx is needed.
export default function AccessError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex flex-1 flex-col gap-4 p-8 text-sm">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-zinc-600 dark:text-zinc-400">Access data could not be displayed right now. No details are shown for safety.</p>
      {error.digest ? <p className="text-xs text-zinc-500">Reference: {error.digest}</p> : null}
      <div className="flex gap-3">
        <button onClick={reset} className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">Try again</button>
        <Link href="/access" className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">Back to Access</Link>
      </div>
    </main>
  );
}
