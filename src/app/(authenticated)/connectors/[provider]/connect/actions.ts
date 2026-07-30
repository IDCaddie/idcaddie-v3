"use server";
// O2A — the `"use server"` boundary for creating a metadata-only Okta connector configuration.
//
// A thin wrapper over the server-only DAL, matching the house pattern (see connectors/review/actions.ts): user-scoped anon client
// only — NEVER service-role — with the tenant resolved server-side and the role re-checked in the database RPC.
//
// NO SECRET CROSSES THIS BOUNDARY. Under the approved architecture (docs/78) IDCaddie owns the signing key and the customer
// supplies only non-secret values, so this action accepts an organization host, a client id and an idempotency token — nothing else.
// Anything else in the form is ignored rather than trusted.

import { createOktaConnectorConfiguration, type CreateOktaConnectorResult } from "@/lib/data/okta-connector-create";

export type OktaConnectFormState =
  | { readonly status: "idle" }
  | { readonly status: "saved"; readonly connectorId: string; readonly orgHost: string; readonly nextAction: string; readonly replay: boolean }
  | { readonly status: "error"; readonly message: string };

// Customer-safe messages. No database text, no exception, no provider response — a reason code is mapped to plain language here so
// nothing internal can reach the browser through an error path.
function messageFor(result: Extract<CreateOktaConnectorResult, { ok: false }>): string {
  switch (result.reason) {
    case "not_authenticated": return "Please sign in to configure this connection.";
    case "no_tenant": return "You need to belong to an organization before you can add a connection.";
    case "insufficient_role": return "You need to be an owner or admin to add a connection.";
    case "invalid_client_id": return "Enter the API Services client ID from your Okta app (it starts with 0oa…).";
    case "invalid_idempotency_key": return "Something went wrong preparing the form. Please reload and try again.";
    case "duplicate_configuration": return "This Okta organization and client ID are already configured for your team.";
    case "invalid_org_host": return orgHostMessage(result.detail);
    default: return "We couldn't save this configuration. Please try again.";
  }
}

function orgHostMessage(detail: string): string {
  switch (detail) {
    case "not_https": return "Enter your Okta address using https, or just the address itself.";
    case "has_credentials": return "Enter just the organization address, without a username or password.";
    case "has_port": return "Enter just the organization address, without a port.";
    case "has_path_or_query": return "Enter just the organization address, without any path or extra characters.";
    case "ip_literal": return "Enter your Okta organization address, not an IP address.";
    case "localhost_or_internal": return "Enter your public Okta organization address.";
    case "apex_only": return "Include your organization name, for example your-company.okta.com.";
    case "not_okta_apex": return "Enter an Okta address ending in .okta.com, .oktapreview.com, or .okta-emea.com.";
    case "bad_label": return "That doesn't look like a valid Okta organization address.";
    default: return "Enter your Okta organization address, for example your-company.okta.com.";
  }
}

export async function saveOktaConfigurationAction(
  _prev: OktaConnectFormState,
  formData: FormData,
): Promise<OktaConnectFormState> {
  // Only these three inputs are read. Any other field a browser posts — tenant id, role, state, fingerprint, scopes, contract
  // version, certification flag — is simply never looked at, so it cannot influence the write.
  const result = await createOktaConnectorConfiguration({
    orgInput: (formData.get("orgHost") ?? "").toString(),
    clientId: (formData.get("clientId") ?? "").toString(),
    idempotencyKey: (formData.get("idempotencyKey") ?? "").toString(),
  });

  if (!result.ok) return { status: "error", message: messageFor(result) };

  return {
    status: "saved",
    connectorId: result.view.connectorId,
    orgHost: result.view.normalizedOrgHost,
    nextAction: result.view.nextRequiredAction,
    replay: result.view.idempotentReplay,
  };
}
