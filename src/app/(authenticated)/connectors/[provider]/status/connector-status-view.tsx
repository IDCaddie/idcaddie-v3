"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/badge";
import { ConnectorIcon } from "@/components/connector-icon";
import { useDemoConnection } from "@/lib/customer-connectors/use-demo-connection";
import { setDemoConnection, clearDemoConnection } from "@/lib/customer-connectors/demo-store";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

const primary = "inline-block rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900";
const secondary = "inline-block rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700";
const panel = "rounded-lg border border-zinc-200 p-4 dark:border-zinc-800";

// The connected-state management view for a preview connection. Entirely driven by the sessionStorage demo state. Actions mutate
// ONLY the demo state — NO server execution authorization, NO task launch, NO schedule, NO credential/token/API. "Run supervised
// first sync" is disabled (a safe explanation), scheduling is shown as unavailable.
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

  const paused = demo.status === "paused_preview";

  return (
    <div className="max-w-3xl space-y-5" aria-live="polite">
      <div className="flex items-center gap-4">
        <ConnectorIcon initial={c.icon.initial} tint={c.icon.tint} size="lg" />
        <div>
          <div className="text-lg font-semibold">{c.displayName}</div>
          <div className="flex items-center gap-2 text-sm">
            <Badge tone={paused ? "attention" : "success"} variant="solid">{paused ? "Paused" : "Connected"}</Badge>
            <span className="text-zinc-500 dark:text-zinc-400">Preview mode · No sync run yet</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <section className={panel}>
          <h2 className="text-sm font-medium">Data access</h2>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Users</li><li>User status</li><li>Approved profile fields</li>
          </ul>
        </section>
        <section className={panel}>
          <h2 className="text-sm font-medium">Security</h2>
          <ul className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Read-only</li>
            <li>Least privilege</li>
            <li>Reauthorization: <span className="text-zinc-800 dark:text-zinc-200">Not required</span></li>
            <li>Connection health: <span className="text-zinc-800 dark:text-zinc-200">Good (preview)</span></li>
          </ul>
        </section>
        <section className={`${panel} sm:col-span-2`}>
          <h2 className="text-sm font-medium">Sync settings</h2>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
            <div className="flex justify-between gap-2"><dt>First sync</dt><dd className="text-zinc-800 dark:text-zinc-200">Manual</dd></div>
            <div className="flex justify-between gap-2"><dt>Scheduling</dt><dd className="text-zinc-800 dark:text-zinc-200">Unavailable in preview</dd></div>
            <div className="flex justify-between gap-2"><dt>Last sync</dt><dd className="text-zinc-800 dark:text-zinc-200">Never</dd></div>
            <div className="flex justify-between gap-2"><dt>Next sync</dt><dd className="text-zinc-800 dark:text-zinc-200">Not scheduled</dd></div>
          </dl>
        </section>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled title="Available after preview" aria-describedby={`${c.provider}-sync-note`} className={primary}>Run supervised first sync</button>
          {paused ? (
            <button type="button" onClick={() => setDemoConnection(c.provider, { ...demo, status: "connected_preview" })} className={secondary}>Resume connection</button>
          ) : (
            <button type="button" onClick={() => setDemoConnection(c.provider, { ...demo, status: "paused_preview" })} className={secondary}>Pause connection</button>
          )}
          <button type="button" onClick={() => router.push(`/connectors/${c.provider}/connect`)} className={secondary}>Reconnect</button>
          <button type="button" onClick={() => { clearDemoConnection(c.provider); setDisconnected(true); }} className={secondary}>Disconnect</button>
        </div>
        <p id={`${c.provider}-sync-note`} className="text-xs text-zinc-500">The first sync isn’t live yet. When it is, it runs once, manually, under supervision — nothing runs automatically and nothing is imported in preview.</p>
      </section>
    </div>
  );
}
