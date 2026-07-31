// O2A — the server-only DAL for creating a metadata-only Okta connector configuration (docs/78).
//
// WHAT THIS IS NOT. There is NO secret here, and there is no secret-write path anywhere in O2A. Under the approved architecture
// IDCaddie owns the signing key (a non-exportable AWS KMS key, provisioned in O2B); the customer supplies only two NON-SECRET
// values — the organization host and the service-app client id. A connector therefore has no per-connector credential at all.
//
// WHAT THIS DOES NOT CLAIM. Nothing here contacts Okta. The row it creates is UNVERIFIED: no token has been minted, so no
// organization has been proven. The organization fingerprint written here is PROPOSED, never verified — the verified column is
// not even a parameter of the RPC, and the database refuses to hold one without a successful validation.
//
// Server-only: it calls next/headers via the user-scoped client, so importing it from client code throws.

import { createClient } from "@/lib/supabase/server";
import { findOwnOktaConnector } from "./okta-connector-status";
import {
  canonicalizeOktaOrgHost,
  deriveOktaOrganizationIdentity,
  type OktaHostReason,
} from "@/lib/customer-connectors/okta-org-identity";

// ── Input / output ──────────────────────────────────────────────────────────────────────────────────────────────
// The ONLY values a browser may supply. Note what is absent: tenant id, actor, role, scopes, contract version, connection state,
// fingerprints, signing key, certification/production flags. Every one of those is derived server-side or by the database.
export type CreateOktaConnectorInput = {
  readonly orgInput: string;        // raw customer input; normalized here
  readonly clientId: string;
  readonly idempotencyKey: string;  // UUID; makes retry safe
};

export type CreateOktaConnectorFailure =
  | { readonly reason: "not_authenticated" }
  | { readonly reason: "no_tenant" }
  | { readonly reason: "insufficient_role" }
  | { readonly reason: "invalid_org_host"; readonly detail: OktaHostReason }
  | { readonly reason: "invalid_client_id" }
  | { readonly reason: "invalid_idempotency_key" }
  | { readonly reason: "duplicate_configuration"; readonly existingConnectorId: string | null }
  | { readonly reason: "write_failed" };

// The browser-safe DTO. Deliberately built by ALLOWLIST from named fields — a denylist would silently pass a future column.
export type OktaConnectorSafeView = {
  readonly connectorId: string;
  readonly provider: "okta";
  readonly normalizedOrgHost: string;
  readonly clientId: string;                 // NON-secret; the customer typed it and must be able to confirm it
  readonly connectionState: "configured";
  readonly authenticationMode: "private_key_jwt";
  readonly contractVersion: string;
  readonly approvedScopes: readonly string[];
  readonly certificationOnly: true;
  readonly productionEnabled: false;
  readonly verified: false;                  // O2A can never produce a verified connection
  readonly nextRequiredAction: OktaNextAction;
  readonly createdAt: string;
  readonly idempotentReplay: boolean;
};

// What the customer must do next. O2A deliberately cannot say "connected" — the platform signing key does not exist yet.
export type OktaNextAction =
  | "platform_signing_key_pending"   // O2B: the KMS key is not provisioned
  | "public_key_publication_pending" // O2C: JWKS/static publication not available
  | "live_validation_required";      // O2D/O2E: everything ready, no live exchange performed

export type CreateOktaConnectorResult =
  | { readonly ok: true; readonly view: OktaConnectorSafeView }
  | { readonly ok: false } & CreateOktaConnectorFailure;

// Okta client ids are opaque ASCII. Mirrors the database CHECK; the server rejects first so the customer gets a useful message
// rather than a constraint error.
const CLIENT_ID = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── The write path ──────────────────────────────────────────────────────────────────────────────────────────────
export async function createOktaConnectorConfiguration(input: CreateOktaConnectorInput): Promise<CreateOktaConnectorResult> {
  const supabase = await createClient();

  // ACTOR — from the session, never from the caller.
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return { ok: false, reason: "not_authenticated" };

  // Structural validation BEFORE touching the database, so an invalid value never reaches a constraint.
  const host = canonicalizeOktaOrgHost(input.orgInput);
  if (!host.ok) return { ok: false, reason: "invalid_org_host", detail: host.reason };

  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  if (clientId.length < 5 || clientId.length > 256 || !CLIENT_ID.test(clientId)) {
    return { ok: false, reason: "invalid_client_id" };
  }
  if (typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey)) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }

  // TENANT — resolved from the actor's membership under RLS, never accepted from the browser. A user with no membership has no
  // tenant to write to, which is a distinct outcome from having the wrong role.
  const { data: memberships, error: mErr } = await supabase
    .from("tenant_memberships")
    .select("tenant_id, role")
    .eq("user_id", auth.user.id);
  if (mErr) return { ok: false, reason: "write_failed" };
  const owning = (memberships ?? []).find((m) => m.role === "owner" || m.role === "admin");
  if (!owning) {
    return { ok: false, reason: (memberships ?? []).length === 0 ? "no_tenant" : "insufficient_role" };
  }

  // FINGERPRINTS — derived here with the reviewed O1C algorithm, never supplied by the browser. The organization fingerprint is
  // PROPOSED only: it is computed from the host and client id, and nothing has been verified against Okta.
  const identity = deriveOktaOrganizationIdentity({ orgHost: host.host, clientId });
  if (!identity.ok) return { ok: false, reason: "invalid_org_host", detail: "bad_label" };

  // The RPC re-checks the role in-body and derives scopes, contract version, auth mode, governance flags and the connection
  // state itself. This layer's checks are defence in depth, not the boundary.
  const { data, error } = await supabase.rpc("create_okta_connector_configuration", {
    p_tenant_id: owning.tenant_id,
    p_normalized_org_host: host.host,
    p_client_id: clientId,
    p_proposed_organization_fingerprint: identity.identity.organizationFingerprint,
    p_service_app_fingerprint: identity.identity.serviceAppFingerprint,
    p_idempotency_key: input.idempotencyKey,
    // p_display_name is omitted rather than passed as null: the RPC defaults it, and the generated type is `string | undefined`.
  });

  if (error) {
    // The RPC raises 42501 for an unauthorized actor. Never surface the raw database message to a browser.
    return { ok: false, reason: error.code === "42501" ? "insufficient_role" : "write_failed" };
  }

  const outcome = (data as { outcome?: string; connector_id?: string } | null)?.outcome;
  if (outcome === "duplicate_configuration") {
    // Look the collision up through RLS. If it belongs to ANOTHER tenant this returns null and the caller shows the generic
    // message — the customer cannot tell "someone else has it" from "it does not exist", which is the point.
    const existingConnectorId = await findOwnOktaConnector(host.host, clientId);
    return { ok: false, reason: "duplicate_configuration", existingConnectorId };
  }
  if (outcome !== "created" && outcome !== "idempotent_replay") return { ok: false, reason: "write_failed" };

  const connectorId = (data as { connector_id: string }).connector_id;

  // Read back through RLS so the view reflects what the database ACTUALLY stored, not what this function believes it wrote.
  const { data: row, error: rErr } = await supabase
    .from("okta_connector_configs")
    .select("normalized_org_host, client_id, contract_version, authentication_mode, approved_scopes, certification_only, production_enabled, verified_organization_fingerprint, signing_key_id, public_key_delivery_mode, created_at")
    .eq("connector_id", connectorId)
    .single();
  if (rErr || !row) return { ok: false, reason: "write_failed" };

  return {
    ok: true,
    view: {
      connectorId,
      provider: "okta",
      normalizedOrgHost: row.normalized_org_host,
      clientId: row.client_id,
      connectionState: "configured",
      authenticationMode: "private_key_jwt",
      contractVersion: row.contract_version,
      approvedScopes: row.approved_scopes ?? [],
      certificationOnly: true,
      productionEnabled: false,
      verified: false,
      nextRequiredAction: nextActionFor(row.signing_key_id, row.public_key_delivery_mode),
      createdAt: row.created_at,
      idempotentReplay: outcome === "idempotent_replay",
    },
  };
}

// The next step is derived from what actually exists, so the UI cannot claim readiness the platform has not reached.
export function nextActionFor(signingKeyId: string | null, deliveryMode: string | null): OktaNextAction {
  if (!signingKeyId) return "platform_signing_key_pending";
  if (!deliveryMode || deliveryMode === "not_configured") return "public_key_publication_pending";
  return "live_validation_required";
}
