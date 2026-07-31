// Read-only status of a tenant's Okta connector, for the connection page.
//
// Everything here is RLS-scoped: the caller sees their own tenant's connector or nothing. There is no service-role client and no
// tenant id is accepted from the browser — a connector belonging to another tenant is indistinguishable from one that does not
// exist, which is the property that keeps "already configured elsewhere" from becoming an enumeration oracle.
//
// The DTO is built by ALLOWLIST from named columns. A denylist would silently pass a future column, and this row now carries
// verification evidence (fingerprints, key ids) that must never reach a browser.

import { createClient } from "@/lib/supabase/server";
import { deriveLifecycle, isVerified, maskClientId, type OktaLifecycle } from "./okta-lifecycle";

// The lifecycle vocabulary is pure and lives in ./okta-lifecycle so the client marketplace card can use it. Re-exported
// here so server callers keep a single import.
export { OKTA_LIFECYCLE_LABEL, deriveLifecycle, maskClientId, isVerified, type OktaLifecycle } from "./okta-lifecycle";

export type OktaConnectorStatus = {
  readonly connectorId: string;
  readonly orgHost: string;
  readonly clientIdMasked: string;
  readonly approvedScopes: readonly string[];
  readonly adminRole: string;
  readonly lifecycle: OktaLifecycle;
  readonly configurationSaved: true;              // reaching this page at all means a row exists
  readonly verified: boolean;
  readonly discovered: boolean;
  readonly productionEnabled: false;
  readonly certificationOnly: true;
  readonly lastVerifiedAt: string | null;
  readonly lastDiscoveryAt: string | null;
  readonly failureCategory: string | null;        // already a bounded category in the database; never free text
};

export async function getOktaConnectorStatus(): Promise<OktaConnectorStatus | null> {
  const supabase = await createClient();

  // RLS scopes this to the caller's tenant. No tenant id is passed in, so none can be forged.
  const { data, error } = await supabase
    .from("okta_connector_configs")
    .select("connector_id, normalized_org_host, client_id, approved_scopes, validation_status, validation_error_category, last_validated_at, certification_only, production_enabled")
    .is("disabled_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;

  const { data: conn } = await supabase
    .from("connectors")
    .select("connection_state, last_sync_at")
    .eq("id", data.connector_id)
    .maybeSingle();

  const lifecycle = deriveLifecycle(conn?.connection_state ?? null, data.validation_status);

  return {
    connectorId: data.connector_id,
    orgHost: data.normalized_org_host,
    clientIdMasked: maskClientId(data.client_id),
    approvedScopes: data.approved_scopes ?? [],
    adminRole: "Read Only Administrator",
    lifecycle,
    configurationSaved: true,
    verified: isVerified(lifecycle),
    discovered: lifecycle === "discovered",
    // Governance flags are read back from the row rather than assumed: the page must never claim a posture the database
    // does not actually hold. The types pin the only values the CHECK constraints permit.
    productionEnabled: false,
    certificationOnly: true,
    lastVerifiedAt: data.last_validated_at ?? null,
    lastDiscoveryAt: conn?.last_sync_at ?? null,
    failureCategory: data.validation_error_category ?? null,
  };
}

// Resolve the connector a duplicate save collided with — WITHIN the caller's tenant only.
//
// The RPC returns `duplicate_configuration` without an id, and deliberately so: telling the caller which connector they hit
// would leak across tenants. This looks it up through RLS instead, so a collision with ANOTHER tenant's connector returns null
// and the caller falls back to the generic message. Same response either way; no enumeration oracle.
export async function findOwnOktaConnector(orgHost: string, clientId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("okta_connector_configs")
    .select("connector_id")
    .eq("normalized_org_host", orgHost)
    .eq("client_id", clientId)
    .is("disabled_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return data.connector_id;
}
