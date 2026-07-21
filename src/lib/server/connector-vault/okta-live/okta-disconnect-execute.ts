// The staging-safe DISCONNECT EXECUTION. Applies the pure disconnect PLAN (planOktaDisconnect) through server-only injected sinks:
// mark the connection disconnected, invalidate execution eligibility immediately, disable any schedule, and revoke the credential
// reference through a server-only interface. Audit history is preserved; it is idempotent; it never reveals a secret/credential
// identifier to the client. NO real Okta revocation endpoint is called (the sink's provider-side revocation is a future
// requirement). Okta is an API Services connector (Client Credentials + private_key_jwt) — there is NO browser OAuth transaction
// to invalidate on disconnect.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { planOktaDisconnect, type OktaDisconnectInput, type OktaCredentialRevocationSink } from "./okta-disconnect";
import { OKTA_PROVIDER_ID } from "./okta-provider-contract";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-disconnect-execute is server-only and must not be imported in client code");
}

// The injected server-only sinks the execution applies. No real implementations ship in this phase.
export interface OktaDisconnectSinks {
  markConnectionDisconnected(input: { connectorId: string; tenantId: string }): Promise<void>;
  disableSchedule(input: { connectorId: string; tenantId: string }): Promise<void>;
  revocation: OktaCredentialRevocationSink;
}

export type OktaDisconnectExecuteResult =
  | { ok: true; noOp: boolean }
  | { ok: false; reason: "not_authenticated" | "insufficient_role" | "apply_failed" };

// Execute a disconnect. Fails closed for a non-admin. Idempotent: an already-disconnected connection performs a safe no-op (no
// re-revocation). The credential reference is never returned/logged; only the plan's boolean effects are applied.
export async function executeOktaDisconnect(
  input: OktaDisconnectInput,
  deps: OktaDisconnectSinks,
): Promise<OktaDisconnectExecuteResult> {
  const planned = planOktaDisconnect(input);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  const plan = planned.plan;

  try {
    // These invariants are asserted even for the idempotent no-op (a re-disconnect must still leave it uneligible + unscheduled).
    await deps.markConnectionDisconnected({ connectorId: input.connectorId, tenantId: input.tenantId });
    await deps.disableSchedule({ connectorId: input.connectorId, tenantId: input.tenantId });
    if (plan.credentialReferenceRevocationRequested) {
      // A NEW disconnect requests revocation; an idempotent no-op does not re-request. No Okta revocation endpoint is called here.
      await deps.revocation.markCredentialReferenceRevoked({ connectorId: input.connectorId, tenantId: input.tenantId, provider: OKTA_PROVIDER_ID });
    }
  } catch {
    return { ok: false, reason: "apply_failed" };
  }
  return { ok: true, noOp: plan.noOp };
}
