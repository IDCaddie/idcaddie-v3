import Link from "next/link";
import { getNeedsAttentionForCurrentUser, type AttentionSection } from "@/lib/data/needs-attention-loader";

export const metadata = { title: "Needs Attention · ID Caddie" };

// Read-only cleanup queue. All data is RLS-scoped ("visible to you"), composed from existing DALs — no
// connector_secrets, no discovery_facts / fact_json, no tokens, no PII beyond names already shown elsewhere.
// Each section fails closed to a safe placeholder; nothing here writes or triggers a sync.

function Section({ s }: { s: AttentionSection }) {
  return (
    <section className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">{s.title}</h2>
        {s.state === "ok" ? (
          <span className="rounded-full border border-amber-500 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            {s.count}
          </span>
        ) : s.state === "empty" ? (
          <span className="rounded-full border border-green-600 px-2 py-0.5 text-xs text-green-700 dark:text-green-400">
            All clear
          </span>
        ) : s.state === "deferred" ? (
          <span className="rounded-full border border-zinc-400 px-2 py-0.5 text-xs text-zinc-500">deferred</span>
        ) : (
          <span className="rounded-full border border-zinc-400 px-2 py-0.5 text-xs text-zinc-500">—</span>
        )}
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{s.explanation}</p>

      {s.state === "error" ? (
        <p className="text-sm text-zinc-500">Temporarily unavailable — try again later.</p>
      ) : s.state === "empty" ? (
        <p className="text-sm text-zinc-500">Nothing needs attention here.</p>
      ) : s.state === "ok" ? (
        <ul className="space-y-1 text-sm">
          {s.items.map((it, i) => (
            <li key={i}>
              <Link href={it.href} className="underline">
                {it.label}
              </Link>
              {it.sublabel ? <span className="text-zinc-500"> — {it.sublabel}</span> : null}
            </li>
          ))}
          {s.count > s.items.length ? (
            <li className="text-zinc-500">
              …and {s.count - s.items.length} more{s.href ? <> — <Link href={s.href} className="underline">view all</Link></> : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

export default async function NeedsAttentionPage() {
  const { sections } = await getNeedsAttentionForCurrentUser();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="space-y-1">
        <div className="text-sm">
          <Link href="/dashboards" className="text-zinc-500 hover:underline">
            ← Back
          </Link>
        </div>
        <h1 className="text-xl font-semibold">Needs Attention</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Items that need cleanup before your SaaS inventory is reliable. Everything here is{" "}
          <strong>read-only</strong> and scoped to what is <strong>visible to you</strong> (RLS) — no sync is
          run and no account details are shown.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {sections.map((s) => (
          <Section key={s.key} s={s} />
        ))}
      </div>
    </main>
  );
}
