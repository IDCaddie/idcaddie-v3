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

// Provider detail. For Okta (the preview-connectable provider) a constrained two-column hero + "what we can / cannot access"
// experience; other providers show a preview / coming-soon detail. Server component; the connect CTA (demo-aware) is a client island.
export default async function ConnectorDetailPage({ params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const c = getCustomerConnector(provider);
  if (!c) notFound();
  const isOkta = c.provider === "okta";

  return (
    <main className="flex flex-1 flex-col p-8">
      <div className="mx-auto w-full max-w-[1120px] space-y-8">
        <div className="text-sm">
          <Link href="/connectors" className="text-zinc-500 hover:underline">← All connectors</Link>
        </div>

        {/* Hero — left: identity + value; right: primary CTA + setup time */}
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="flex items-start gap-4">
            <ConnectorIcon initial={c.icon.initial} tint={c.icon.tint} size="xl" />
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">{c.displayName}</h1>
              <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                <span>{c.category}</span>
                <span aria-hidden="true">·</span>
                {c.availability === "coming_soon" ? <Badge tone="neutral" variant="solid">Not available yet</Badge> : <Badge tone="attention" variant="solid">Preview</Badge>}
              </div>
              <p className="max-w-xl text-sm text-zinc-700 dark:text-zinc-300">{isOkta ? OKTA_CONTENT.valueStatement : c.description}</p>
            </div>
          </div>
          <div className="md:pt-1"><ConnectorDetailCta connector={c} /></div>
        </div>

        {/* Access — two equal-height cards; stacks on narrow screens */}
        {isOkta ? (
          <section id="access" className="grid scroll-mt-8 gap-4 sm:grid-cols-2">
            <div className="flex flex-col rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h2 className="text-base font-semibold">{OKTA_CONTENT.accessTitle}</h2>
              <ul className="mt-3 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                {OKTA_CONTENT.reads.map((r) => (
                  <li key={r} className="flex gap-2"><span aria-hidden="true" className="mt-0.5 shrink-0 text-green-600">✓</span><span>{r}</span></li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h2 className="text-base font-semibold">{OKTA_CONTENT.noAccessTitle}</h2>
              <ul className="mt-3 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                {OKTA_CONTENT.doesNotAccess.map((r) => (
                  <li key={r} className="flex gap-2"><span aria-hidden="true" className="mt-0.5 shrink-0 text-zinc-400">✕</span><span>{r}</span></li>
                ))}
              </ul>
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="text-base font-semibold">What ID Caddie would read</h2>
            <ul className="mt-3 flex flex-wrap gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              {c.capabilities.map((cap) => <li key={cap} className="rounded border border-zinc-200 px-2 py-0.5 dark:border-zinc-800">{cap}</li>)}
            </ul>
          </section>
        )}

        {/* Initial scope — three concise indicators + one reassurance line */}
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Initial scope</h2>
          <ul className="flex flex-wrap gap-2">
            {(isOkta ? OKTA_CONTENT.initialScope : ["Read-only", "No automatic sync"]).map((s) => (
              <li key={s} className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">{s}</li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500">{isOkta ? OKTA_CONTENT.scopeNote : "Nothing is imported until the connection is approved and the first sync is started."}</p>
        </section>
      </div>
    </main>
  );
}
