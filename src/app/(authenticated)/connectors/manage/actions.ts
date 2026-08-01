"use server";
import { revalidatePath } from "next/cache";
import { accessGate, disconnectConnector, reconnectConnector, replaceConnector } from "@/lib/data/access-repository";

// Phase 5 — the three operator actions on a connector.
//
// Each is a thin shell over a SECURITY DEFINER RPC that does its own owner/admin check, tenant scoping, precondition checks and
// audit write. Authorization is never decided here: this layer only resolves the tenant from the trusted server-side context and
// maps a bounded reason code to reviewed copy. No tenant id is accepted from the browser.
//
// None of them deletes anything. Disconnect and replace are read-time exclusions — the directory rows, discovery runs and audit
// history stay exactly as they are, and reconnect restores the connector by clearing a column.

export type ActionState = { ok: boolean; message: string } | null;

const MESSAGE: Record<string, string> = {
  disconnected: "Directory disconnected. Its records and history are retained and can be restored by reconnecting.",
  already_disconnected: "That directory is already disconnected.",
  reconnected: "Directory reconnected. Its existing records are visible again.",
  already_active: "That directory is already active.",
  replaced: "Directory marked as replaced. Its records and history are retained.",
  already_superseded: "That directory has already been replaced.",
  not_found: "That directory could not be found.",
  superseded: "That directory was replaced by another; undo the replacement first.",
  successor_inactive: "The replacement directory is itself disconnected or replaced.",
  provider_mismatch: "A directory can only be replaced by one from the same provider.",
  same_connector: "A directory cannot replace itself.",
};
const say = (reason: string | undefined, fallback: string) => (reason && MESSAGE[reason]) || fallback;

async function tenant(): Promise<string | null> {
  const g = await accessGate();
  return g.ok ? g.tenantId : null;
}

export async function disconnectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenant();
  if (!t) return { ok: false, message: "You don’t have access to this area." };
  const id = String(form.get("connectorId") ?? "");
  const reason = String(form.get("reason") ?? "");
  if (!reason.trim()) return { ok: false, message: "A reason is required — someone will need to explain this decision later." };
  const r = await disconnectConnector(t, id, reason);
  revalidatePath("/connectors/manage");
  return r.ok ? { ok: true, message: say(r.reason, MESSAGE.disconnected) } : { ok: false, message: say(r.reason, "Could not disconnect that directory. Please try again later.") };
}

export async function reconnectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenant();
  if (!t) return { ok: false, message: "You don’t have access to this area." };
  const r = await reconnectConnector(t, String(form.get("connectorId") ?? ""));
  revalidatePath("/connectors/manage");
  return r.ok ? { ok: true, message: say(r.reason, MESSAGE.reconnected) } : { ok: false, message: say(r.reason, "Could not reconnect that directory. Please try again later.") };
}

export async function replaceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await tenant();
  if (!t) return { ok: false, message: "You don’t have access to this area." };
  const reason = String(form.get("reason") ?? "");
  if (!reason.trim()) return { ok: false, message: "A reason is required — someone will need to explain this decision later." };
  const r = await replaceConnector(t, String(form.get("connectorId") ?? ""), String(form.get("replacementId") ?? ""), reason);
  revalidatePath("/connectors/manage");
  return r.ok ? { ok: true, message: say(r.reason, MESSAGE.replaced) } : { ok: false, message: say(r.reason, "Could not record that replacement. Please try again later.") };
}
