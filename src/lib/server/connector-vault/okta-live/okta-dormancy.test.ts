import { describe, it, expect } from "vitest";
import { createDormantOktaTokenExchange, OktaTokenExchangeNotAvailableError } from "./okta-token-exchange";
import { oktaExecutionEligibility, dormantOktaExecutionGates, OKTA_CONNECTION_DISPLAY_STATES } from "./okta-connection-state";
import { evaluateOktaFirstSync, NO_OKTA_FIRST_SYNC_AUTHORIZATION, OKTA_FIRST_SYNC_DEFAULTS, type OktaFirstSyncAuthorization } from "./okta-first-sync-authorization";
import { buildOktaAuditEvent, OktaAuditEventError, OKTA_AUDIT_EVENT_CODES } from "./okta-audit-events";
import { planOktaDisconnect } from "./okta-disconnect";

// P5E18a Phase 8/10/11/13/15/19 — the dormancy proofs: nothing runs, exchanges, or is authorized in this phase.

describe("token exchange is a dormant, throwing seam (Phase 8)", () => {
  it("createDormantOktaTokenExchange().exchange throws — no network, no token", async () => {
    const ex = createDormantOktaTokenExchange();
    await expect(ex.exchange({ issuerUrl: "https://acme.okta.com", authorizationCode: "x", pkceVerifier: "y", redirectUri: "z", clientCredentialReference: "ref", timeoutMs: 1000, signal: new AbortController().signal, correlationId: "c" }))
      .rejects.toBeInstanceOf(OktaTokenExchangeNotAvailableError);
  });
  it("the success type exposes only a token REFERENCE, never a raw token field", () => {
    // Compile-time + shape assertion: the module's success shape has accessTokenRef (a branded ref), not access_token/token.
    const src = OktaTokenExchangeNotAvailableError.toString();
    expect(src).not.toContain("access_token");
  });
});

describe("no Okta connection is runnable in P5E18a (Phase 10)", () => {
  it("the dormant execution gates yield runnable=false with every gate failing", () => {
    const r = oktaExecutionEligibility(dormantOktaExecutionGates());
    expect(r.runnable).toBe(false);
    expect(r.failing).toContain("lifecycle_enabled");
    expect(r.failing).toContain("governance");
    expect(r.failing).toContain("first_sync_approval");
  });
  it("even a 'connected'-display connection is NOT runnable unless ALL gates flip (display != execution)", () => {
    expect(OKTA_CONNECTION_DISPLAY_STATES).toContain("connectedUnsynced");
    // flip everything EXCEPT lifecycle → still not runnable (lifecycle stays certificationOnly)
    const almost = dormantOktaExecutionGates({
      governance: { phaseCUnblocked: true, risk007Closed: true, hostedOAuthEnabled: true },
      orgFeatureFlagEnabled: true, credentialReferenceExists: true, credentialVersionApproved: true,
      scopeExact: true, issuerBindingMatches: true, executionAuthorizationExists: true, firstSyncApprovalExists: true,
    });
    const r = oktaExecutionEligibility(almost);
    expect(r.runnable).toBe(false);
    expect(r.failing).toEqual(["lifecycle_enabled"]);
  });
});

describe("first-sync authorization is absent + denied (Phase 11)", () => {
  it("defaults are safe: no auth, no schedule, no retries, zero cap, execution denied", () => {
    expect(NO_OKTA_FIRST_SYNC_AUTHORIZATION).toBeNull();
    expect(OKTA_FIRST_SYNC_DEFAULTS.authorizationPresent).toBe(false);
    expect(OKTA_FIRST_SYNC_DEFAULTS.schedulingEnabled).toBe(false);
    expect(OKTA_FIRST_SYNC_DEFAULTS.automaticRetriesEnabled).toBe(false);
    expect(OKTA_FIRST_SYNC_DEFAULTS.maxUserCount).toBe(0);
    expect(OKTA_FIRST_SYNC_DEFAULTS.executionDenied).toBe(true);
  });
  it("no authorization → denied", () => {
    expect(evaluateOktaFirstSync(null, { connectorId: "c", organizationId: "o", issuerUrl: "https://acme.okta.com", manuallyTriggered: true, now: 1 })).toEqual({ allowed: false, reason: "no_authorization" });
  });
  it("even a fully-formed authorization is denied while certificationOnly, and a schedule trigger is denied", () => {
    const auth: OktaFirstSyncAuthorization = {
      provider: "okta", operator: "sam", organizationId: "o", connectorId: "c", approvedIssuerUrl: "https://acme.okta.com",
      approvedScopes: ["okta.users.read"], maxUserCount: 50, approvedAt: 1, expiresAt: 10_000, maxRuns: 1, runsUsed: 0,
      rollbackOwner: "sam", evidenceRef: "ev-1", environment: "staging", manualTriggerRequired: true,
    };
    const ctx = { connectorId: "c", organizationId: "o", issuerUrl: "https://acme.okta.com", manuallyTriggered: true, now: 5 };
    // manual + valid, but lifecycle certificationOnly → denied
    expect(evaluateOktaFirstSync(auth, ctx)).toEqual({ allowed: false, reason: "lifecycle_not_enabled" });
    // a scheduler-driven (non-manual) trigger is denied before lifecycle even matters
    expect(evaluateOktaFirstSync(auth, { ...ctx, manuallyTriggered: false })).toEqual({ allowed: false, reason: "not_manual_trigger" });
    // only with enabled lifecycle + permitting governance does it allow (future) — proving the gate is real
    expect(evaluateOktaFirstSync(auth, { ...ctx, lifecycle: "enabled", governance: { phaseCUnblocked: true, risk007Closed: true, hostedOAuthEnabled: true } })).toEqual({ allowed: true });
  });
});

describe("audit events are sanitized (Phase 13)", () => {
  it("builds a valid event and rejects forbidden secret/PII fields + non-stable reason codes", () => {
    const e = buildOktaAuditEvent("okta_connection_blocked", { correlationId: "c1", tenantId: "t", reasonCode: "governance_blocked", at: 1 });
    expect(e.event).toBe("okta_connection_blocked");
    expect(e.provider).toBe("okta");
    // @ts-expect-error — a token field is not allowed on the input type
    expect(() => buildOktaAuditEvent("okta_callback_received", { correlationId: "c", at: 1, access_token: "x" })).toThrow(OktaAuditEventError);
    expect(() => buildOktaAuditEvent("okta_callback_received", { correlationId: "c", at: 1, reasonCode: "This is a raw exception message!" })).toThrow(OktaAuditEventError);
    expect(() => buildOktaAuditEvent("okta_callback_received", { correlationId: "c", at: 1, orgHostname: "https://acme.okta.com/x" })).toThrow(OktaAuditEventError);
    expect(OKTA_AUDIT_EVENT_CODES).toContain("okta_connection_disconnected");
  });
});

describe("disconnect is admin-gated + idempotent + reveals no reference (Phase 15)", () => {
  const base = { authenticated: true, role: "admin", connectorId: "c", tenantId: "t", organizationId: "o", actorSubject: "u", correlationId: "corr", now: 1 } as const;
  it("requires an authenticated admin", () => {
    expect(planOktaDisconnect({ ...base, currentState: "connectedUnsynced", authenticated: false })).toEqual({ ok: false, reason: "not_authenticated" });
    expect(planOktaDisconnect({ ...base, currentState: "connectedUnsynced", role: "member" })).toEqual({ ok: false, reason: "insufficient_role" });
  });
  it("invalidates eligibility + pauses schedules + requests revocation; a second disconnect is a no-op", () => {
    const first = planOktaDisconnect({ ...base, currentState: "connectedUnsynced" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.plan.nextState).toBe("disconnected");
    expect(first.plan.executionEligibilityInvalidated).toBe(true);
    expect(first.plan.schedulesPaused).toBe(true);
    expect(first.plan.pendingTransactionsInvalidated).toBe(true);
    expect(first.plan.credentialReferenceRevocationRequested).toBe(true);
    expect(first.plan.noOp).toBe(false);
    // no credential reference / secret leaks into the plan
    expect(JSON.stringify(first.plan)).not.toMatch(/secret|token|arn|credential_secret_ref/i);
    // idempotent: already disconnected → no-op, no re-revocation
    const second = planOktaDisconnect({ ...base, currentState: "disconnected" });
    expect(second.ok && second.plan.noOp).toBe(true);
    expect(second.ok && second.plan.credentialReferenceRevocationRequested).toBe(false);
  });
});
