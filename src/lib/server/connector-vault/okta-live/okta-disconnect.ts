// P5E18a — the DORMANT Okta DISCONNECT / revocation transition (Phase 15). PURE, server-only. It PLANS the state transitions a
// disconnect performs, without calling any Okta revocation API and without revealing the credential reference to the client. It:
//   - requires an authorized administrator;
//   - invalidates future execution eligibility immediately;
//   - pauses schedules (even though none exist);
//   - invalidates pending OAuth transactions;
//   - marks the credential reference revoked / pending-deletion through an INTERFACE (not implemented here);
//   - preserves required audit history (emits a disconnected event);
//   - is IDEMPOTENT (a second disconnect is a safe no-op).
// It does NOT reveal the credential reference to the client and makes NO network call. The future real revocation procedure is
// documented in the runbook. SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID } from "./okta-provider-contract";
import { buildOktaAuditEvent, type OktaAuditEvent } from "./okta-audit-events";
import type { OktaConnectionDisplayState } from "./okta-connection-state";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-disconnect is server-only and must not be imported in client code");
}

// The interface a future phase implements to mark the external credential reference revoked / pending-deletion. It NEVER returns
// the reference value; the plan carries no reference. Dormant: no implementation is wired.
export interface OktaCredentialRevocationSink {
  markCredentialReferenceRevoked(input: { connectorId: string; tenantId: string; provider: typeof OKTA_PROVIDER_ID }): Promise<void>;
}

export type OktaDisconnectDenyReason = "insufficient_role" | "not_authenticated";

export type OktaDisconnectInput = {
  authenticated: boolean;
  role: string | null;
  connectorId: string;
  tenantId: string;
  organizationId: string;
  actorSubject: string;
  currentState: OktaConnectionDisplayState;
  correlationId: string;
  now: number;
  adminRoles?: readonly string[];
};

// The planned effects — pure data. A future executor applies them (transition, pause schedules, invalidate transactions, revoke
// via the sink). The plan NEVER contains a credential reference/secret/token.
export type OktaDisconnectPlan = {
  provider: typeof OKTA_PROVIDER_ID;
  connectorId: string;
  nextState: OktaConnectionDisplayState; // "disconnected"
  executionEligibilityInvalidated: true;
  schedulesPaused: true;
  pendingTransactionsInvalidated: true;
  credentialReferenceRevocationRequested: boolean; // false when already disconnected (idempotent no-op)
  noOp: boolean; // true when already disconnected
  auditEvents: readonly OktaAuditEvent[];
};

export type OktaDisconnectResult =
  | { ok: true; plan: OktaDisconnectPlan }
  | { ok: false; reason: OktaDisconnectDenyReason };

const DEFAULT_ADMIN_ROLES = ["owner", "admin"] as const;

// Plan a disconnect. Fails closed if the actor is not an authenticated admin. Idempotent: if already disconnected, returns a safe
// no-op plan (no revocation re-requested) that still asserts the invariants (eligibility invalid, schedules paused).
export function planOktaDisconnect(input: OktaDisconnectInput): OktaDisconnectResult {
  const adminRoles = input.adminRoles ?? DEFAULT_ADMIN_ROLES;
  if (input.authenticated !== true) return { ok: false, reason: "not_authenticated" };
  if (typeof input.role !== "string" || !adminRoles.includes(input.role)) return { ok: false, reason: "insufficient_role" };

  const alreadyDisconnected = input.currentState === "disconnected";
  const auditEvents = alreadyDisconnected
    ? []
    : [
        buildOktaAuditEvent("okta_connection_disconnected", {
          correlationId: input.correlationId,
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          connectorId: input.connectorId,
          actorSubject: input.actorSubject,
          at: input.now,
        }),
      ];

  return {
    ok: true,
    plan: {
      provider: OKTA_PROVIDER_ID,
      connectorId: input.connectorId,
      nextState: "disconnected",
      executionEligibilityInvalidated: true,
      schedulesPaused: true,
      pendingTransactionsInvalidated: true,
      credentialReferenceRevocationRequested: !alreadyDisconnected,
      noOp: alreadyDisconnected,
      auditEvents,
    },
  };
}
