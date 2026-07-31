import Link from "next/link";
import { OKTA_LIFECYCLE_LABEL, type OktaConnectorStatus } from "@/lib/data/okta-connector-status";

// The REAL connector state, server-rendered from `connectors` + `okta_connector_configs` through RLS. No browser-local demo
// state is consulted here — this panel is the authority on what actually exists, and the marketplace card's simulated state
// has no bearing on it.

// Stage order is the customer's mental model, not the database's. Verification and discovery are shown as SEPARATE stages
// because they fail independently and are performed at different times.
const STAGES = [
  { key: "configuration", label: "Configuration" },
  { key: "verification", label: "Verification" },
  { key: "discovery", label: "Initial discovery" },
] as const;

function stageState(s: OktaConnectorStatus, key: (typeof STAGES)[number]["key"]): string {
  if (s.lifecycle === "failed") {
    // A failure is attributed to the stage it actually happened in rather than smeared across all three.
    if (key === "configuration") return "Complete";
    if (key === "verification" && !s.verified) return "Failed";
    return s.verified ? "Failed" : "Not started";
  }
  if (key === "configuration") return "Complete";
  if (key === "verification") return s.verified ? "Complete" : s.lifecycle === "verifying" ? "In progress" : "Pending";
  return s.discovered ? "Complete" : s.lifecycle === "discovering" ? "In progress" : "Pending";
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function OktaStatusPanel({ status }: { status: OktaConnectorStatus }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-800 dark:border-zinc-700 dark:text-zinc-200">
          {OKTA_LIFECYCLE_LABEL[status.lifecycle]}
        </span>
        {/* Never "Connected": a saved configuration is not a connection, and a verified connection is not a sync. */}
        <span className="text-xs text-zinc-500">Production synchronization disabled</span>
      </div>

      {status.failureCategory && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Last attempt reported: {status.failureCategory.replace(/_/g, " ")}
        </p>
      )}

      <dl className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Okta organization</dt><dd className="text-right"><code className="text-zinc-700 dark:text-zinc-300">{status.orgHost}</code></dd></div>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Client ID</dt><dd className="text-right"><code className="text-zinc-700 dark:text-zinc-300">{status.clientIdMasked}</code></dd></div>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Scopes</dt><dd className="text-right">{status.approvedScopes.map((s) => <code key={s} className="block text-zinc-700 dark:text-zinc-300">{s}</code>)}</dd></div>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Administrator role</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">{status.adminRole}</dd></div>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Last verified</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">{fmt(status.lastVerifiedAt)}</dd></div>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Last discovery</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">{fmt(status.lastDiscoveryAt)}</dd></div>
        <div className="flex items-start justify-between gap-4 px-3 py-2.5"><dt className="text-zinc-500">Production synchronization</dt><dd className="text-right text-zinc-700 dark:text-zinc-300">Disabled</dd></div>
      </dl>

      <div>
        <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Progress</h2>
        <ol className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {STAGES.map((st) => (
            <li key={st.key} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <span className="text-zinc-700 dark:text-zinc-300">{st.label}</span>
              <span className="text-zinc-500">{stageState(status, st.key)}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Operator-assisted reality. Stated as content, not as a disabled button the customer will try to press. */}
      {!status.discovered && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
          <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">What happens next</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Verification and initial discovery are operator-assisted during the staging pilot. Your configuration is saved;
            ID Caddie operations verifies the connection against your Okta organization, then runs the first discovery.
            Return to this page to see status and results — you do not need to do anything else.
          </p>
        </div>
      )}

      {/* Only shown once discovery has actually produced records. Before that these routes are real but empty, and sending the customer
          to three empty lists would read as a failed connector. */}
      {status.discovered && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/access" className="inline-flex items-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
              View access data
            </Link>
            {[
              { href: "/directory/people", label: "People" },
              { href: "/directory/groups", label: "Groups" },
              { href: "/directory/applications", label: "Applications" },
            ].map((l) => (
              <Link key={l.href} href={l.href} className="inline-flex items-center rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500">
                {l.label}
              </Link>
            ))}
          </div>
          {/* The two application models are genuinely separate surfaces; saying so prevents "the catalog is empty, so
              discovery failed" — a conclusion the numbers otherwise invite. */}
          <p className="text-xs text-zinc-500">
            Okta directory applications and access relationships appear under Access. App Catalog is a separate SaaS
            normalization surface and may not contain corresponding products yet.
          </p>
        </div>
      )}
    </div>
  );
}
