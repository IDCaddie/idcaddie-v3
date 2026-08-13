import { Badge } from "@/components/badge";
import { CONCEPTS, CONCEPT_DEFINITION, CONCEPT_LABEL, type EntitlementReconciliation, type Measure } from "@/lib/server/commercial-analytics/types";
import type { ContractCommercialView } from "@/lib/data/commercial-loader";

// Phase 10 — the purchased-vs-discovered panel on contract detail. Server-rendered, presentational: every number here was
// computed by the engines and handed over finished. This component performs NO arithmetic, so there is no second place for a
// commercial figure to be derived.
//
// THE RULE THIS COMPONENT EXISTS TO KEEP. A quantity with no source renders its SENTENCE, never a zero and never a dash that a
// reader would take for a zero. `Measure` makes that structural — `value` exists only on the `measured` variant — but the
// rendering has to honour it too, which is what `MeasureCell` below is for.

function MeasureCell({ label, definition, measure }: { label: string; definition: string; measure: Measure }) {
  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500" title={definition}>
        {label}
      </div>
      {measure.state === "measured" ? (
        <>
          <div className="text-lg font-semibold tabular-nums">{measure.value.toLocaleString()}</div>
          <div className="mt-0.5 text-xs text-zinc-500">{measure.basis}</div>
        </>
      ) : (
        // Not a number, not a dash. The explanation is the answer.
        <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{measure.explanation}</div>
      )}
    </div>
  );
}

function GapRow({ r }: { r: EntitlementReconciliation }) {
  if (r.gap.state === "not_comparable") {
    return <p className="text-xs text-zinc-600 dark:text-zinc-400">{r.gap.reason}</p>;
  }
  if (r.gap.state === "aligned") {
    return (
      <p className="text-sm">
        <Badge tone="success">Aligned</Badge>{" "}
        <span className="text-zinc-600 dark:text-zinc-400">
          Purchased and provisioned both read {r.gap.quantity.toLocaleString()}.
        </span>
      </p>
    );
  }
  const over = r.gap.state === "purchase_exceeds_discovered";
  return (
    <p className="text-sm">
      <Badge tone={over ? "attention" : "danger"}>
        {over ? `${r.gap.surplus.toLocaleString()} more purchased` : `${r.gap.excess.toLocaleString()} more accounts`}
      </Badge>{" "}
      <span className="text-zinc-600 dark:text-zinc-400">
        {r.gap.purchased.toLocaleString()} purchased · {r.gap.discovered.toLocaleString()} provisioned
      </span>
    </p>
  );
}

function OpportunityRow({ r }: { r: EntitlementReconciliation }) {
  if (r.opportunity.state === "estimated") {
    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: r.opportunity.currency,
      maximumFractionDigits: 0,
    }).format(r.opportunity.annualAmount);
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
        <div className="font-medium">
          Estimated {money} / year if the quantity were reduced at renewal
        </div>
        {/* The arithmetic always travels with the number. A money figure a customer cannot check is a number they cannot use. */}
        <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{r.opportunity.basis}</div>
      </div>
    );
  }
  return (
    <p className="text-xs text-zinc-600 dark:text-zinc-400">
      {r.opportunity.state === "none" ? r.opportunity.reason : `No estimate: ${r.opportunity.reason}`}
    </p>
  );
}

export function EntitlementsPanel({ view }: { view: ContractCommercialView | null }) {
  if (view === null) {
    return (
      <section className="space-y-2 text-sm">
        <h2 className="font-medium">Purchased entitlements</h2>
        <p className="text-zinc-600 dark:text-zinc-400">
          Could not load the purchased lines for this contract right now.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 text-sm">
      <div>
        <h2 className="font-medium">Purchased entitlements</h2>
        <p className="text-xs text-zinc-500">
          What this contract records as bought, compared with what the declared connector found. Purchased, assigned,
          provisioned, billable and active are different measurements and are never combined.
        </p>
      </div>

      {view.entitlementCount === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No purchased line has been recorded for this contract, so what it bought is not represented. This is not a
          quantity of zero.
        </p>
      ) : (
        view.reconciliations.map((r) => (
          <article key={r.entitlementId} className="space-y-3 rounded border border-zinc-300 p-4 dark:border-zinc-700">
            <header className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">{r.label}</div>
              <div className="flex flex-wrap items-center gap-2">
                {r.staleEvidence ? <Badge tone="attention">Some evidence is stale</Badge> : null}
                <Badge tone="neutral">{r.provenance.confidence} confidence</Badge>
              </div>
            </header>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {CONCEPTS.map((c) => (
                <MeasureCell
                  key={c}
                  label={`${CONCEPT_LABEL[c]}${c === "purchased" ? ` (${r.unit}s)` : ""}`}
                  definition={CONCEPT_DEFINITION[c]}
                  measure={r.measures[c]}
                />
              ))}
            </div>

            <GapRow r={r} />
            <OpportunityRow r={r} />
          </article>
        ))
      )}

      {!view.discoveredEvidenceReadable ? (
        <p className="text-xs text-zinc-500">
          Discovered account evidence is not readable with your access, so the comparison is unavailable rather than
          empty.
        </p>
      ) : null}

      {view.findings.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">Commercial findings</h3>
          <ul className="space-y-2">
            {view.findings.map((f) => (
              <li key={f.id} className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={f.tone}>{f.severityLabel}</Badge>
                  <span className="font-medium">{f.title}</span>
                  {f.money ? <Badge tone="attention">{f.money}</Badge> : null}
                </div>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">{f.summary}</p>
                {f.guidance ? <p className="mt-1 text-xs text-zinc-500">{f.guidance}</p> : null}
                {f.provenanceNote ? <p className="mt-1 text-xs text-zinc-500">{f.provenanceNote}</p> : null}
                {f.basis ? <p className="mt-1 text-xs text-zinc-500">{f.basis}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-zinc-500">
        These figures describe purchased quantities and discovered accounts. They do not represent application usage, and
        an account the provider reports as inactive is not evidence that a licence is being charged for.
      </p>
    </section>
  );
}
