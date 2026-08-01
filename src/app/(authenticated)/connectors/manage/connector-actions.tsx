"use client";
import { useActionState } from "react";
import { disconnectAction, reconnectAction, replaceAction, type ActionState } from "./actions";
import type { ConnectorSummary } from "@/lib/data/connector-management";

// Phase 5 — the three operator actions, each behind an explicit reason.
//
// Disconnect and replace both ask for a reason and both say, in the form itself, exactly what they do and do not remove. That is
// not reassurance copy: an operator who believes disconnect deletes their audit trail will avoid using it and leave a stale
// directory active instead, which is the worse outcome.

function Result({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? "text-zinc-600 dark:text-zinc-400" : "text-red-700 dark:text-red-400"}`}>
      {state.message}
    </p>
  );
}

export function DisconnectForm({ connector }: { connector: ConnectorSummary }) {
  const [state, action, pending] = useActionState(disconnectAction, null);
  return (
    <form action={action} className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="text-sm font-medium">Disconnect this directory</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Removes it from Home, Directory, Access and Findings. Its people, groups, applications, discovery runs and audit history are
        all <strong>retained</strong> — nothing is deleted, and reconnecting restores everything exactly as it was.
      </p>
      <input type="hidden" name="connectorId" value={connector.id} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-500">Reason (required)</span>
        <input name="reason" required maxLength={500} placeholder="Why is this directory being retired?"
          className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
      </label>
      <button type="submit" disabled={pending} className="rounded border border-zinc-400 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-zinc-600">
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function ReconnectForm({ connector }: { connector: ConnectorSummary }) {
  const [state, action, pending] = useActionState(reconnectAction, null);
  return (
    <form action={action} className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="text-sm font-medium">Reconnect this directory</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Its existing people, groups and applications become visible again immediately. Nothing is re-discovered, because nothing was
        removed.
      </p>
      <input type="hidden" name="connectorId" value={connector.id} />
      <button type="submit" disabled={pending} className="rounded border border-zinc-400 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-zinc-600">
        {pending ? "Reconnecting…" : "Reconnect"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function ReplaceForm({ connector, candidates }: { connector: ConnectorSummary; candidates: readonly ConnectorSummary[] }) {
  const [state, action, pending] = useActionState(replaceAction, null);
  if (candidates.length === 0) {
    return (
      <div className="space-y-1 rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <h3 className="text-sm font-medium">Replace this directory</h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          There is no other active {connector.provider} directory to replace it with. Add and verify the replacement first, then
          return here to record the handover.
        </p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-2 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="text-sm font-medium">Replace this directory</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Use this when another connector now reads the <strong>same organization</strong> — for example after re-creating the
        integration. This directory is excluded from active views and the replacement takes over; both keep all of their records and
        history. If the two read <em>different</em> organizations, disconnect instead: replacing would hide a directory that is
        still real.
      </p>
      <input type="hidden" name="connectorId" value={connector.id} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-500">Replaced by</span>
        <select name="replacementId" required className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900">
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.organization ? ` · ${c.organization}` : ""}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-500">Reason (required)</span>
        <input name="reason" required maxLength={500} placeholder="Why does the replacement read the same organization?"
          className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
      </label>
      <button type="submit" disabled={pending} className="rounded border border-zinc-400 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-zinc-600">
        {pending ? "Recording…" : "Record replacement"}
      </button>
      <Result state={state} />
    </form>
  );
}
