// P5E18b — the CONNECTED-UNSYNCED connection persistence (Phase 9). The future success handler a callback would run AFTER a
// validated exchange + credential write: it atomically records the connection as connected-but-unsynced with the validated issuer
// binding, credential reference, exact granted scope, sync count 0, last-sync null, scheduling disabled, first-sync authorization
// absent, an audit event, and the transaction consumed. Partial-failure rolls back (the injected atomic writer). This success path
// is UNREACHABLE while Okta is certificationOnly (the callback stops before exchange), so no real connection is created now.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, OKTA_APPROVED_SCOPES, scopesExactlyApproved } from "./okta-provider-contract";
import { buildOktaAuditEvent, type OktaAuditEvent } from "./okta-audit-events";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-connection-persist is server-only and must not be imported in client code");
}

// The exact connected-unsynced record persisted. Non-secret only (references the credential by version metadata, never a value).
export type OktaConnectedUnsyncedRecord = {
  provider: typeof OKTA_PROVIDER_ID;
  organizationId: string;
  connectionId: string;
  issuerBindingId: string;
  credentialVersion: string; // non-secret version metadata (the reference itself is written by the credential-write boundary)
  grantedScopes: readonly string[];
  status: "connected_unsynced";
  syncCount: 0;
  lastSyncAt: null;
  schedulingEnabled: false;
  firstSyncAuthorizationPresent: false;
  createdAt: number;
  updatedAt: number;
};

// The injected atomic writer: it persists the connection record, records the audit event, and consumes the transaction in ONE
// atomic unit — if any step fails, all are rolled back. No real implementation ships in this phase.
export interface OktaConnectionWriter {
  commitConnectedUnsynced(input: { record: OktaConnectedUnsyncedRecord; audit: OktaAuditEvent; correlationId: string }): Promise<void>;
}

export type OktaConnectionPersistInput = {
  organizationId: string;
  connectionId: string;
  issuerBindingId: string;
  credentialVersion: string;
  grantedScopes: readonly string[];
  correlationId: string;
  actorSubject: string;
  tenantId: string;
  orgHostname: string;
  now: number;
};

export type OktaConnectionPersistResult =
  | { ok: true; connectionId: string; status: "connected_unsynced" }
  | { ok: false; reason: "invalid_input" | "scope_not_exact" | "commit_failed_rolled_back" };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export async function persistOktaConnectedUnsynced(input: OktaConnectionPersistInput, deps: { writer: OktaConnectionWriter }): Promise<OktaConnectionPersistResult> {
  if (!nonEmpty(input.organizationId) || !nonEmpty(input.connectionId) || !nonEmpty(input.issuerBindingId) || !nonEmpty(input.credentialVersion) || !nonEmpty(input.correlationId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (scopesExactlyApproved(input.grantedScopes).ok !== true) return { ok: false, reason: "scope_not_exact" };

  const record: OktaConnectedUnsyncedRecord = {
    provider: OKTA_PROVIDER_ID,
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    issuerBindingId: input.issuerBindingId,
    credentialVersion: input.credentialVersion,
    grantedScopes: [...OKTA_APPROVED_SCOPES],
    status: "connected_unsynced",
    syncCount: 0,
    lastSyncAt: null,
    schedulingEnabled: false,
    firstSyncAuthorizationPresent: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const audit = buildOktaAuditEvent("okta_connection_ready_for_supervised_sync", {
    correlationId: input.correlationId,
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    connectorId: input.connectionId,
    orgHostname: input.orgHostname,
    actorSubject: input.actorSubject,
    at: input.now,
  });
  try {
    await deps.writer.commitConnectedUnsynced({ record, audit, correlationId: input.correlationId });
  } catch {
    return { ok: false, reason: "commit_failed_rolled_back" }; // the injected writer rolls back the whole unit
  }
  return { ok: true, connectionId: input.connectionId, status: "connected_unsynced" };
}
