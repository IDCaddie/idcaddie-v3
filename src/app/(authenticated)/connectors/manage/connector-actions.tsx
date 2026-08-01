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
      <ConsequenceList />
      <input type="hidden" name="connectorId" value={connector.id} />
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-500">Reason (required)</span>
        <input name="reason" required maxLength={500} placeholder="Why is this directory being retired?"
          className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900" />
      </label>
      <label className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <input type="checkbox" required className="mt-1" />
        <span>I understand this hides the directory from active views and deletes nothing.</span>
      </label>
      <button type="submit" disabled={pending} className="rounded border border-red-400 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400">
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
      <ReconnectConsequences />
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

// ── Row-level lifecycle actions, for the management list ─────────────────────────────────────────────────────────────────────
// The backend for disconnect and reconnect existed from Phase 5 but was reachable only from the detail page, so an operator
// looking at their estate could see that a connector should be retired and had no way to do it from there.
//
// Both are behind a <details> disclosure rather than a bare button: retiring a directory changes what every other page shows, and
// a one-click control in a table row is too easy to hit by accident. Opening the disclosure reveals the full consequence list and
// the mandatory reason.
export function RowLifecycleActions({ connector, kinds }: { connector: ConnectorSummary; kinds: readonly string[] }) {
  if (kinds.includes("reconnect")) return <RowReconnect connector={connector} />;
  if (kinds.includes("disconnect")) return <RowDisconnect connector={connector} />;
  return null;
}

function RowDisconnect({ connector }: { connector: ConnectorSummary }) {
  const [state, action, pending] = useActionState(disconnectAction, null);
  return (
    <details className="relative inline-block">
      <summary className="cursor-pointer list-none text-red-700 underline dark:text-red-400">Disconnect</summary>
      <form action={action} className="absolute right-0 z-10 mt-1 w-80 space-y-2 rounded border border-zinc-300 bg-white p-3 text-left shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
        <p className="text-xs font-medium">Disconnect {connector.name}?</p>
        <ConsequenceList />
        <input type="hidden" name="connectorId" value={connector.id} />
        <input name="reason" required maxLength={500} placeholder="Reason (required)"
          className="w-full rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900" />
        <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" required className="mt-0.5" />
          <span>I understand this hides the directory from active views and deletes nothing.</span>
        </label>
        <button type="submit" disabled={pending} className="w-full rounded border border-red-400 px-2 py-1 text-xs font-medium text-red-700 disabled:opacity-50 dark:border-red-800 dark:text-red-400">
          {pending ? "Disconnecting…" : "Confirm disconnect"}
        </button>
        <Result state={state} />
      </form>
    </details>
  );
}

function RowReconnect({ connector }: { connector: ConnectorSummary }) {
  const [state, action, pending] = useActionState(reconnectAction, null);
  return (
    <details className="relative inline-block">
      <summary className="cursor-pointer list-none underline">Reconnect</summary>
      <form action={action} className="absolute right-0 z-10 mt-1 w-80 space-y-2 rounded border border-zinc-300 bg-white p-3 text-left shadow-lg dark:border-zinc-700 dark:bg-zinc-950">
        <p className="text-xs font-medium">Reconnect {connector.name}?</p>
        <ReconnectConsequences />
        <input type="hidden" name="connectorId" value={connector.id} />
        <button type="submit" disabled={pending} className="w-full rounded border border-zinc-400 px-2 py-1 text-xs font-medium disabled:opacity-50 dark:border-zinc-600">
          {pending ? "Reconnecting…" : "Confirm reconnect"}
        </button>
        <Result state={state} />
      </form>
    </details>
  );
}

// The full consequence list, shared by every disconnect surface so the two cannot drift apart. Each line is a fact an operator
// would otherwise have to guess at, and the guesses are what stop people using disconnect at all.
export function ConsequenceList() {
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
      <li>Future verification and discovery are disabled for it.</li>
      <li>It leaves Home, Directory, Access and Findings.</li>
      <li>Nothing changes in {"“"}your identity provider{"”"} — no provider-side object is touched.</li>
      <li>Its people, groups and applications are retained.</li>
      <li>Its discovery runs and audit history are retained.</li>
      <li>You can reconnect it at any time. Nothing is deleted.</li>
    </ul>
  );
}

export function ReconnectConsequences() {
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
      <li>Its existing records become visible again — history was never removed.</li>
      <li>It does <strong>not</strong> re-verify the connection automatically.</li>
      <li>It does <strong>not</strong> declare its discovered data current again.</li>
      <li>It returns to the lifecycle state it already had; further verification or discovery may still be required.</li>
    </ul>
  );
}
