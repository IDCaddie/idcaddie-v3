// Phase 5 — the workspace's ACTIVE connectors, and which one the current view is scoped to.
//
// A workspace can hold several directories: Corporate Okta, a sandbox, a subsidiary. They are separate organizations and their
// graphs are never merged — a person in the sandbox is not the same person as their corporate account, and adding the two
// headcounts together would be a fiction. So every identity surface reads EITHER one connector or all of them, and says which.
//
// The scope lives in the URL (`?connection=<uuid>`), already parsed and UUID-validated by `parseAccessFilters`. That makes a
// scoped view shareable, back-button-correct, and impossible to desync between Home, Directory, Access and Findings — they all
// read the same parameter.
//
// A requested connector is only honoured if it resolves to an ACTIVE connector in the caller's own tenant. A foreign, unknown,
// superseded or disconnected id silently falls back to "all active" rather than erroring: the id came from a URL, and a URL is
// not a claim about what exists.

import { createClient } from "@/lib/supabase/server";
import { accessGate } from "./access-repository";

export type ScopeConnector = {
  readonly id: string;
  readonly label: string;              // display name, else the organization, else the provider — never a bare uuid
  readonly provider: string;
  readonly organization: string | null;
};

export type ConnectorScope = {
  readonly tenantId: string;
  readonly active: readonly ScopeConnector[];
  readonly selected: ScopeConnector | null;   // null = every active connector
  readonly connectionId: string | null;       // what to pass to the RPCs
  readonly multiple: boolean;                 // more than one active directory, so the scope is a real choice
};

export type ConnectorScopeResult = { ok: true; scope: ConnectorScope } | { ok: false; error: "forbidden" | "query_failed" };

// A connector without a display name still needs something a human can pick from a menu. Falling back through organization to
// provider keeps a uuid off the screen.
export const scopeLabel = (r: { display_name?: string | null; organization?: string | null; provider: string }): string =>
  r.display_name?.trim() || r.organization?.trim() || r.provider;

export async function resolveConnectorScope(requestedConnectionId: string | null): Promise<ConnectorScopeResult> {
  const g = await accessGate();
  if (!g.ok) return { ok: false, error: "forbidden" };

  // Two small RLS-scoped reads, not the counts-heavy inventory RPC. This runs in the layout on EVERY authenticated page, and a
  // switcher menu needs a name and a provider — not six count subqueries per connector.
  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("connectors")
    .select("id, provider, display_name, superseded_by, disconnected_at")
    .is("superseded_by", null)
    .is("disconnected_at", null)
    .order("created_at", { ascending: true });
  if (error) { console.error("[data/connector-scope] connectors read failed"); return { ok: false, error: "query_failed" }; }

  // The organization distinguishes two Okta connectors far better than a display name does; without it, "Okta" and "Okta" are
  // indistinguishable in a menu. Non-fatal: a failed read just means the fallback label is used.
  const { data: cfgs } = await supabase.from("okta_connector_configs").select("connector_id, normalized_org_host").is("disabled_at", null);
  const orgOf = new Map((cfgs ?? []).map((c) => [c.connector_id, c.normalized_org_host]));

  const active: ScopeConnector[] = (rows ?? []).map((r) => {
    const organization = orgOf.get(r.id) ?? null;
    return { id: r.id, label: scopeLabel({ ...r, organization }), provider: r.provider, organization };
  });

  // An id that does not resolve to an ACTIVE connector is dropped, not rejected. Erroring would turn a stale bookmark into a
  // dead end, and honouring it would let a disconnected directory reappear through a hand-edited URL.
  const selected = requestedConnectionId ? active.find((c) => c.id === requestedConnectionId) ?? null : null;

  return {
    ok: true,
    scope: {
      tenantId: g.tenantId,
      active,
      selected,
      connectionId: selected?.id ?? null,
      multiple: active.length > 1,
    },
  };
}
