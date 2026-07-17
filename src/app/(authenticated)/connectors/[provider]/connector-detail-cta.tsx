"use client";
import Link from "next/link";
import { useDemoConnection } from "@/lib/customer-connectors/use-demo-connection";
import type { CustomerConnector } from "@/lib/customer-connectors/catalog-types";

const primary = "inline-block rounded bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-zinc-900";
const secondary = "inline-block rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700";

// The detail-page connect CTA, demo-state aware. Already connected in preview → manage; connectable → Connect + Learn how it
// works; preview-not-connectable → connection coming soon; coming-soon → nothing (the header badge carries it).
export function ConnectorDetailCta({ connector: c }: { connector: CustomerConnector }) {
  const demo = useDemoConnection(c.provider);
  if (demo?.status === "connected_preview" || demo?.status === "paused_preview") {
    return (
      <div className="flex flex-col items-end gap-1">
        <Link href={`/connectors/${c.provider}/status`} className={primary}>View connection</Link>
        <span className="text-xs text-green-700 dark:text-green-400">Connected in preview mode</span>
      </div>
    );
  }
  if (c.canConnect) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/connectors/${c.provider}/connect`} className={primary}>Connect {c.displayName}</Link>
        <a href="#how-it-works" className={secondary}>Learn how it works</a>
      </div>
    );
  }
  if (c.availability === "preview") {
    return <span aria-disabled="true" className="inline-block rounded border border-zinc-200 px-4 py-2 text-sm text-zinc-400 dark:border-zinc-800">Connection coming soon</span>;
  }
  return null;
}
