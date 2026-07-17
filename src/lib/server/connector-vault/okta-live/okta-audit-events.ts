// P5E18a — sanitized Okta connection-lifecycle AUDIT EVENT builders (Phase 13). PURE, server-only. These are typed builders ONLY —
// there is NO writer and NO call site in this phase (dormant). An event records stable CODES + non-secret correlation/identity
// metadata. It NEVER records an authorization code, token, secret, PKCE verifier, full/sensitive issuer URL, customer profile data
// (PII), or a raw provider error body — a runtime guard rejects secret-shaped fields, and only a stable reasonCode is allowed
// (never a raw exception message).
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID } from "./okta-provider-contract";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-audit-events is server-only and must not be imported in client code");
}

export const OKTA_AUDIT_EVENT_CODES = Object.freeze([
  "okta_connection_initiated",
  "okta_connection_blocked",
  "okta_callback_received",
  "okta_callback_rejected",
  "okta_authorization_cancelled",
  "okta_connection_ready_for_supervised_sync",
  "okta_connection_paused",
  "okta_connection_disconnected",
] as const);
export type OktaAuditEventCode = (typeof OKTA_AUDIT_EVENT_CODES)[number];

// The SAFE, non-secret fields an event may carry. orgHostname (not the full issuer URL) is the only host-ish value; reasonCode is a
// stable code (never a raw message). No token/code/secret/PII field is permitted.
export type OktaAuditEventInput = {
  correlationId: string;
  tenantId?: string;
  organizationId?: string;
  connectorId?: string;
  orgHostname?: string; // non-secret; deliberately NOT the full issuer URL
  reasonCode?: string; // a STABLE code only (e.g. "governance_blocked") — never a raw exception message
  actorSubject?: string; // the acting user id (an opaque uuid) — identity, not PII
  at: number; // epoch ms
};

export type OktaAuditEvent = Readonly<OktaAuditEventInput & { event: OktaAuditEventCode; provider: typeof OKTA_PROVIDER_ID }>;

export class OktaAuditEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OktaAuditEventError";
  }
}

// A CLOSED allowlist of the only keys an event may carry — every one is non-secret by construction. Any other key (a secret/
// token/code/verifier/PII/error-body field) is rejected outright. This whitelist is the authoritative guard (stronger than a
// blacklist, which would false-positive on safe keys like "reasonCode").
const ALLOWED_KEYS = new Set(["correlationId", "tenantId", "organizationId", "connectorId", "orgHostname", "reasonCode", "actorSubject", "at"]);
// A stable reason code is a short lowercase token — never a sentence / raw message.
const STABLE_REASON_RE = /^[a-z][a-z0-9_]{1,63}$/;

// Build a sanitized audit event. Rejects unknown/forbidden keys, a non-stable reason code, and a missing correlation/timestamp.
export function buildOktaAuditEvent(event: OktaAuditEventCode, input: OktaAuditEventInput): OktaAuditEvent {
  if (!OKTA_AUDIT_EVENT_CODES.includes(event)) throw new OktaAuditEventError("unknown okta audit event code");
  if (!input || typeof input !== "object") throw new OktaAuditEventError("invalid audit event input");
  if (typeof input.correlationId !== "string" || input.correlationId.length === 0) throw new OktaAuditEventError("correlationId required");
  if (!Number.isFinite(input.at)) throw new OktaAuditEventError("at (timestamp) required");
  for (const k of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(k)) throw new OktaAuditEventError(`disallowed audit field "${k}" (only non-secret allowlisted keys permitted)`);
  }
  if (input.reasonCode !== undefined && !STABLE_REASON_RE.test(input.reasonCode)) {
    throw new OktaAuditEventError("reasonCode must be a stable code, not a raw message");
  }
  // orgHostname must be a bare host (defense in depth — never a full URL with scheme/path, no whitespace or control chars).
  if (input.orgHostname !== undefined && (/[/:?#\s]/.test(input.orgHostname) || /[\x00-\x1f\x7f]/.test(input.orgHostname) || input.orgHostname.length > 255)) {
    throw new OktaAuditEventError("orgHostname must be a bare host");
  }
  return Object.freeze({ event, provider: OKTA_PROVIDER_ID, ...input });
}
