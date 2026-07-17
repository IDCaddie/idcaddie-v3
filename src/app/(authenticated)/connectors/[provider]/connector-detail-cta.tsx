"use client";
import Link from "next/link";
import { useDemoConnection } from "@/lib/customer-connectors/use-demo-connection";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

const primary = "inline-block rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900";

// The detail-page connect CTA, demo-state aware. Already connected in preview → View connection; connectable → Connect + setup
// time + a SUBTLE text link that scrolls to the access section (not a competing button); preview-not-connectable → coming soon;
// coming-soon → nothing (the header badge carries it).
export function ConnectorDetailCta({ connector: c }: { connector: CustomerConnector }) {
  const demo = useDemoConnection(c.provider);
  if (demo?.status === "connected_preview" || demo?.status === "paused_preview") {
    return (
      <div className="flex flex-col items-start gap-1 md:items-end">
        <Link href={`/connectors/${c.provider}/status`} className={primary}>View connection</Link>
        <span className="text-xs text-green-700 dark:text-green-400">Connected in preview mode</span>
      </div>
    );
  }
  if (c.canConnect) {
    const setup = `Setup takes ${c.setupTime.charAt(0).toLowerCase()}${c.setupTime.slice(1)}`;
    return (
      <div className="flex flex-col items-start gap-1.5 md:items-end">
        <Link href={`/connectors/${c.provider}/connect`} className={primary}>Connect {c.displayName}</Link>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{setup}</span>
        <a href="#access" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300">See what ID Caddie can access</a>
      </div>
    );
  }
  if (c.availability === "preview") {
    return <span aria-disabled="true" className="inline-block rounded-md border border-zinc-200 px-5 py-2.5 text-sm text-zinc-400 dark:border-zinc-800">Connection coming soon</span>;
  }
  return null;
}
