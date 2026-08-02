"use client";

// The pending screen. It renders the server's answer and, while that answer is non-terminal, asks again on a bounded
// schedule. It has no opinion of its own: there is no optimistic "Connected", no local success state, and no way for
// this component to reach a terminal word that the database did not return.
//
// Polling stops on the first terminal state and, failing that, after MAX_POLLS. An unbounded poller on a page a customer
// might leave open is a self-inflicted load problem, and the honest thing to show when it stops is that the connection
// is still in progress — not a guess about how it ended.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ConnectionState, ConnectionStatus } from "@/lib/data/oauth-completion-status";

export const POLL_INTERVAL_MS = 5000;
export const MAX_POLLS = 36; // three minutes; the job's own deadline is ten

type Copy = { heading: string; body: string; retry: boolean };

// Customer language. No job ids, no timestamps, no reason codes, no "worker", "claim", "enqueue", "envelope" or
// "correlation" — this is the screen, not the runbook.
const COPY: Record<ConnectionState, Copy> = {
  completing: {
    heading: "Completing your Slack connection",
    body: "This usually takes a few seconds. You can leave this page open.",
    retry: false,
  },
  completed: {
    heading: "Connection completed",
    body: "Slack is connected. Your workspace data will appear after the first sync.",
    retry: false,
  },
  failed: {
    heading: "Connection failed",
    body: "We could not complete this Slack connection. Nothing was changed.",
    retry: true,
  },
  expired: {
    heading: "Connection expired",
    body: "This connection request took too long and is no longer valid.",
    retry: true,
  },
};

const STILL_WORKING = "This is taking longer than usual. Refresh this page to check again.";

export function PendingStatus({
  correlationId,
  initial,
  poll,
}: {
  correlationId: string;
  initial: ConnectionStatus;
  poll: (correlationId: string) => Promise<ConnectionStatus>;
}) {
  const [status, setStatus] = useState<ConnectionStatus>(initial);
  const [exhausted, setExhausted] = useState(false);

  // The dependency is the INITIAL terminality, not the live one. Depending on `status.terminal` would restart the whole
  // effect on every poll and leave "stop on terminal" resting on React's teardown timing rather than on a line of code
  // — which is exactly how a guard ends up untestable. Here the `next.terminal` return below is the only thing that
  // stops the loop, so removing it is observable.
  useEffect(() => {
    if (initial.terminal) return;
    let cancelled = false;
    let polls = 0;

    const tick = async () => {
      polls += 1;
      let next: ConnectionStatus | null = null;
      try {
        next = await poll(correlationId);
      } catch {
        // A failed poll is not a failed connection. Keep the current state and try again until the budget runs out.
      }
      // ONE cancellation check, placed after the only await. Anything before it is already covered by `clearTimeout`,
      // and a second copy after it would make both untestable — each would mask the other's removal.
      if (cancelled) return;
      if (next) {
        setStatus(next);
        if (next.terminal) return;
      }
      if (polls >= MAX_POLLS) {
        setExhausted(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    let timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [correlationId, poll, initial.terminal]);

  const copy = COPY[status.state];
  return (
    <section className="max-w-lg space-y-4" aria-live="polite">
      <h1 className="text-xl font-semibold">{copy.heading}</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{copy.body}</p>
      {!status.terminal && exhausted ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{STILL_WORKING}</p>
      ) : null}
      <div className="flex gap-3 text-sm">
        {copy.retry ? (
          <Link href="/connectors/slack" className="font-medium underline">
            Retry connection
          </Link>
        ) : null}
        <Link href="/connectors" className="text-zinc-500 underline">
          Back to connections
        </Link>
      </div>
    </section>
  );
}
