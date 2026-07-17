import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomerConnector } from "@/lib/customer-connectors/catalog";
import { OKTA_CONTENT } from "@/lib/customer-connectors/okta-content";
import { ConnectorIcon } from "@/components/connector-icon";
import { Badge } from "@/components/badge";
import { ConnectorDetailCta } from "./connector-detail-cta";

export async function generateMetadata({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const c = getCustomerConnector(provider);
  return { title: c ? `${c.displayName} · Connectors · ID Caddie` : "Connector · ID Caddie" };
}

// Provider detail. For Okta (the preview-connectable provider) it shows the full "what we read / what we don't" experience; other
// providers show a preview / coming-soon detail. Server component; the connect CTA (demo-aware) is a small client island.
export default async function ConnectorDetailPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const c = getCustomerConnector(provider);
  if (!c) notFound();
  const isOkta = c.provider === "okta";

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="text-sm">
        <Link href="/connectors" className="text-zinc-500 hover:underline">← All connectors</Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <ConnectorIcon initial={c.icon.initial} tint={c.icon.tint} size="lg" />
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{isOkta ? OKTA_CONTENT.title : c.displayName}</h1>
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span>{c.category}</span>
              {c.availability === "coming_soon" ? <Badge tone="neutral" variant="solid">Coming soon</Badge> : <Badge tone="attention" variant="solid">Preview</Badge>}
            </div>
          </div>
        </div>
        <ConnectorDetailCta connector={c} />
      </header>

      <p className="max-w-2xl text-sm text-zinc-700 dark:text-zinc-300">{isOkta ? OKTA_CONTENT.valueStatement : c.description}</p>

      {isOkta ? (
        <div id="how-it-works" className="grid max-w-3xl scroll-mt-8 grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="text-sm font-medium">What ID Caddie reads</h2>
            <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
              {OKTA_CONTENT.reads.map((r) => <li key={r} className="flex items-center gap-2"><span aria-hidden className="text-green-600">✓</span>{r}</li>)}
            </ul>
          </section>
          <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="text-sm font-medium">What ID Caddie never accesses</h2>
            <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
              {OKTA_CONTENT.doesNotAccess.map((r) => <li key={r} className="flex items-center gap-2"><span aria-hidden className="text-zinc-400">✕</span>{r}</li>)}
            </ul>
          </section>
        </div>
      ) : (
        <section className="max-w-2xl rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium">What ID Caddie would read</h2>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            {c.capabilities.map((cap) => <li key={cap} className="rounded border border-zinc-200 px-2 py-0.5 dark:border-zinc-800">{cap}</li>)}
          </ul>
        </section>
      )}

      <section className="max-w-2xl space-y-2 text-sm">
        <h2 className="font-medium">Initial scope</h2>
        <ul className="flex flex-wrap gap-2 text-zinc-600 dark:text-zinc-400">
          {(isOkta ? OKTA_CONTENT.initialScope : ["Read-only", "No automatic scheduling"]).map((s) => (
            <li key={s} className="rounded-full border border-zinc-200 px-2.5 py-0.5 text-xs dark:border-zinc-800">{s}</li>
          ))}
        </ul>
        <p className="text-xs text-zinc-500">Estimated setup time: {isOkta ? OKTA_CONTENT.setupTime : c.setupTime}. Read-only, and nothing syncs until a connection is fully ready.</p>
      </section>
    </main>
  );
}
