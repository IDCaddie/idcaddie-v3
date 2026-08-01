import Link from "next/link";
import { Badge } from "@/components/badge";
import { CAPABILITIES, canShowValue, type CapabilityStatus, type SourceState } from "@/lib/canonical/capabilities";

// Phase 7B — what each source can and cannot tell this workspace.
//
// The rule this panel enforces on the whole product: a capability that is not `available` renders its EXPLANATION, never a
// number. "Requires a Slack connector" and "0 active users" are different claims, and only one of them is true.

const TONE: Record<SourceState, "success" | "attention" | "danger" | "neutral"> = {
  available: "success", stale: "attention", incomplete: "attention", review_required: "attention",
  failed: "danger", not_connected: "neutral", source_required: "neutral", unavailable: "neutral", unknown: "neutral",
  // Plan and permission limits are the WORKSPACE's constraint, not a fault — toned as information, and actionable in the
  // permission case because reauthorizing with another scope genuinely fixes it.
  plan_dependent: "neutral", permission_dependent: "attention",
};
const STATE_LABEL: Record<SourceState, string> = {
  available: "Available", stale: "Stale", incomplete: "Not discovered", review_required: "Review required",
  failed: "Failed", not_connected: "Not connected", source_required: "Source required",
  unavailable: "Not available yet", unknown: "Unknown",
  plan_dependent: "Not on this plan", permission_dependent: "Needs permission",
};

// A capability the product has not built is shown once, collapsed — a long list of "not available yet" would bury the states
// that are actionable.
export function CapabilityMatrix({ statuses }: { statuses: Record<string, CapabilityStatus> }) {
  const all = CAPABILITIES.map((c) => statuses[c]).filter(Boolean);
  const live = all.filter((s) => s.support === "implemented");
  const planned = all.filter((s) => s.support !== "implemented");

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {live.map((s) => (
          <li key={s.capability} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.label}</span>
              <Badge tone={TONE[s.state]}>{STATE_LABEL[s.state]}</Badge>
              {s.provider && <span className="text-xs text-zinc-400">{s.provider}</span>}
            </span>
            <span className="text-xs text-zinc-500">{s.explanation}</span>
          </li>
        ))}
      </ul>
      {planned.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-zinc-500">
            {planned.length} further {planned.length === 1 ? "capability" : "capabilities"} not available yet
          </summary>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {planned.map((s) => <li key={s.capability}><Badge tone="neutral">{s.label}</Badge></li>)}
          </ul>
          <p className="mt-2 text-xs text-zinc-500">
            These are not zero — ID Caddie has not built ingestion for them yet, so no value can be reported either way. Connecting
            a provider does not enable a capability the product does not read.
          </p>
        </details>
      )}
    </div>
  );
}

// A metric that CANNOT be shown. Renders the reason in place of the number — the single component that keeps an unsupported
// capability from ever appearing as 0.
export function UnavailableMetric({ status, href }: { status: CapabilityStatus; href?: string }) {
  const body = (
    <>
      <div className="text-sm font-medium text-zinc-400">—</div>
      <div className="mt-0.5 text-xs text-zinc-500">{status.label}</div>
      <div className="mt-0.5 text-[11px] text-zinc-400">{status.explanation}</div>
    </>
  );
  const cls = "rounded-lg border border-dashed border-zinc-300 p-3 dark:border-zinc-700";
  return href ? <Link href={href} className={`${cls} block`}>{body}</Link> : <div className={cls}>{body}</div>;
}

// Pick the renderer from the capability state rather than from whether a number happened to be computed.
export function CapabilityMetric({
  status, value, label, href, render,
}: { status: CapabilityStatus; value: number | null; label: string; href?: string; render: (v: number) => React.ReactNode }) {
  if (!canShowValue(status) || value === null) return <UnavailableMetric status={{ ...status, label }} href={href} />;
  return <>{render(value)}</>;
}
