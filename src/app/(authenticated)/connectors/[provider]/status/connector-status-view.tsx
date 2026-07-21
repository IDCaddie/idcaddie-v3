"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/badge";
import { ConnectorIcon } from "@/components/connector-icon";
import { useDemoConnection } from "@/lib/customer-connectors/use-demo-connection";
import { setDemoConnection, clearDemoConnection } from "@/lib/customer-connectors/demo-store";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

const primary = "inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900";
const secondary = "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700";
const panel = "rounded-xl border border-zinc-200 p-5 dark:border-zinc-800";
const heading = "text-sm font-semibold text-zinc-900 dark:text-zinc-100";
// First-sync is not available in preview. Uses aria-disabled (NOT native disabled) so it stays keyboard-focusable and its
// aria-describedby explanation is reachable/announced; the onClick is a no-op guard.
const firstSyncDisabled = "inline-flex cursor-not-allowed items-center justify-center rounded-md bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500";

// The connected-state management view for a preview connection. Entirely driven by the sessionStorage demo state. Actions mutate
// ONLY the demo state — NO server execution authorization, NO task launch, NO schedule, NO credential/token/API. "Run supervised
// first sync" is disabled (with a plain-language explanation); scheduling is shown as unavailable during preview.
export function ConnectorStatusView({ connector: c }: { connector: CustomerConnector }) {
  const demo = useDemoConnection(c.provider);
  const router = useRouter();
  const [disconnected, setDisconnected] = useState(false);

  if (disconnected || !demo) {
    return (
      // role="status" so the disconnect confirmation is announced when this subtree replaces the connected view.
      <div role="status" className={`${panel} max-w-xl`}>
        <div className="font-medium">{disconnected ? `${c.displayName} disconnected` : `${c.displayName} is not connected`}</div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{disconnected ? "The preview connection was removed. No data was ever imported." : "Connect it in preview to see connection details."}</p>
        {c.canConnect ? <Link href={`/connectors/${c.provider}/connect`} className={`${primary} mt-3`}>Connect {c.displayName}</Link> : null}
        <Link href="/connectors" className="mt-3 ml-2 text-sm underline">All connectors</Link>
      </div>
    );
  }

  // Okta API Services onboarding: configuration saved but NOT verified. Never presented as connected/active — no browser OAuth,
  // no token minted; a real client-credentials verification happens later out of band.
  if (demo.status === "verification_pending") {
    return (
      <div className="max-w-3xl space-y-6" aria-live="polite">
        <div className="flex items-start gap-4">
          <ConnectorIcon initial={c.icon.initial} tint={c.icon.tint} size="xl" />
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">{c.displayName}</h2>
            <div className="flex items-center gap-2 text-sm">
              <Badge tone="attention" variant="solid">Verification pending</Badge>
              <span className="text-zinc-500 dark:text-zinc-400">· Configuration saved</span>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Your Okta service application configuration has been saved. ID Caddie has not yet verified the connection or imported any data.</p>
          </div>
        </div>
        <section className={`${panel} max-w-xl`}>
          <h3 className={heading}>What happens next</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <li>ID Caddie will verify the service application before any data is read.</li>
            <li>No sync has run. No data has been imported.</li>
            <li>Scheduling is unavailable until the connection is verified.</li>
          </ul>
        </section>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => router.push(`/connectors/${c.provider}/connect`)} className={secondary}>Edit configuration</button>
          <button type="button" onClick={() => { clearDemoConnection(c.provider); setDisconnected(true); }} className={secondary}>Remove configuration</button>
        </div>
      </div>
    );
  }

  const paused = demo.status === "paused_preview";

  return (
    <div className="max-w-3xl space-y-6" aria-live="polite">
      {/* Header */}
      <div className="flex items-start gap-4">
        <ConnectorIcon initial={c.icon.initial} tint={c.icon.tint} size="xl" />
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight">{c.displayName}</h2>
          <div className="flex items-center gap-2 text-sm">
            <Badge tone={paused ? "attention" : "success"} variant="solid">{paused ? "Paused" : "Connected"}</Badge>
            <span className="text-zinc-500 dark:text-zinc-400">· Preview</span>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{paused ? "Paused — resume to continue in preview." : "Ready for a supervised first sync"}</p>
        </div>
      </div>

      {/* Sections */}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className={panel}>
          <h3 className={heading}>Connection status</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <li>{paused ? "Paused" : "Connected"}</li>
            <li>No sync has run</li>
          </ul>
        </section>

        <section className={panel}>
          <h3 className={heading}>Data access</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Users</li>
            <li>Account status</li>
            <li>Basic profile information</li>
          </ul>
        </section>

        <section className={panel}>
          <h3 className={heading}>Sync</h3>
          <dl className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <div className="flex justify-between gap-2"><dt>First sync</dt><dd className="text-zinc-800 dark:text-zinc-200">Not started</dd></div>
            <div className="flex justify-between gap-2"><dt>Last sync</dt><dd className="text-zinc-800 dark:text-zinc-200">Never</dd></div>
            <div className="flex justify-between gap-2"><dt>Scheduling</dt><dd className="text-zinc-800 dark:text-zinc-200">Unavailable during preview</dd></div>
          </dl>
        </section>

        <section className={panel}>
          <h3 className={heading}>Security</h3>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Read-only</li>
            <li>Only the access listed above</li>
            <li>Reauthorization not required</li>
          </ul>
        </section>
      </div>

      {/* Actions */}
      <section className="space-y-3">
        <h3 className={heading}>Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-disabled="true" aria-describedby={`${c.provider}-sync-note`} onClick={(e) => e.preventDefault()} className={firstSyncDisabled}>Run supervised first sync</button>
          {paused ? (
            <button type="button" onClick={() => setDemoConnection(c.provider, { ...demo, status: "connected_preview" })} className={secondary}>Resume connection</button>
          ) : (
            <button type="button" onClick={() => setDemoConnection(c.provider, { ...demo, status: "paused_preview" })} className={secondary}>Pause connection</button>
          )}
          <button type="button" onClick={() => router.push(`/connectors/${c.provider}/connect`)} className={secondary}>Reconnect</button>
          <button type="button" onClick={() => { clearDemoConnection(c.provider); setDisconnected(true); }} className={secondary}>Disconnect</button>
        </div>
        <p id={`${c.provider}-sync-note`} className="text-xs text-zinc-500">The first sync isn’t available yet. When it is, it runs once, manually, under supervision — nothing runs automatically and nothing is imported during preview.</p>
      </section>
    </div>
  );
}
