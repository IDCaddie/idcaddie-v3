// Server-only OAuth `oauth_pending` single-use CONSUME path (docs/42 §16/§32.3/§33/§38, gated vault).
//
// This is the atomic single-use consume the OAuth callback needs to mark a pending state CONSUMED EXACTLY
// ONCE — the last replay-store prerequisite before a first connector can even be sketched. It does NOT
// exchange OAuth codes, store any token/credential, touch `connector_secrets`, or use a request-path
// privileged client. **The vault stays NOT usable for real credentials.**
//
// DENY-ALL PRESERVED. `oauth_pending` is Tier-2 deny-all (RLS-enabled, zero policies, zero anon/authenticated
// grant — migration `0020`, org_rls_test.sql T42). A request-path (`authenticated`) client therefore CANNOT
// touch it. The consume runs as the SERVER-ONLY connector-runner identity, NOT a browser/request principal —
// so this module owns only the PURE consume LOGIC + the result classification, and delegates the actual
// privileged DB write to an INJECTED `OAuthPendingConsumer` (the runner-identity-backed executor, wired in a
// later gated PR). No service-role path reachable from request/browser code is added here; no migration is
// needed (deny-all is unchanged).
//
// ATOMIC SINGLE-USE. The executor's `runAtomicConsume` performs ONE statement — the reference SQL is:
//
//   update public.oauth_pending
//      set consumed_at = $now
//    where state_jti   = $state_jti
//      and nonce_hash  = $nonce_hash
//      and tenant_id   = $tenant_id
//      and provider    = $provider
//      and connector_id is not distinct from $connector_id   -- null-safe (fresh connect has null)
//      and consumed_at is null                               -- not already consumed
//      and expires_at  > $now                                -- not expired
//   returning id, state_jti, consumed_at;
//
// A concurrent second callback finds `consumed_at` already set (or 0 rows) → it consumes NOTHING. Success is
// "exactly one row changed"; on 0 rows the path does a READ-ONLY classify (by the unique `state_jti`) to
// return a SAFE reason code — never mutating again, so single-use is preserved.
//
// REDACTION (docs/42 §11): a result carries only a safe reason CODE + non-secret metadata (state_jti,
// consumed_at timestamp). NEVER a raw nonce, raw state, authorization code, provider payload, or any secret.
// Nothing here calls console.* and nothing logs the inputs.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// It has NO imports (pure TS) — no DB, no Supabase, no service-role, no `process.env`.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-pending-consume is server-only and must not be imported in client code");
}

// The validated identity inputs a caller supplies (all non-secret: ids + hashes, never the raw nonce/state).
export type OAuthPendingConsumeInput = {
  tenantId: string;
  provider: string;
  connectorId?: string | null; // null for a fresh connect (matched null-safe)
  subject?: string | null; // optional; not part of the single-use key, carried for audit by the runner
  stateJti: string; // the unique correlation id
  nonceHash: string; // sha256(nonce) hex — never the raw nonce
  now: number; // epoch ms (injectable for deterministic tests)
};

export type OAuthPendingConsumeReason =
  | "malformed_input"
  | "not_found"
  | "already_consumed"
  | "expired"
  | "tenant_mismatch"
  | "provider_mismatch"
  | "connector_mismatch"
  | "nonce_mismatch";

export type OAuthPendingConsumeResult =
  | { ok: true; consumed: { stateJti: string; consumedAt: string } } // safe metadata only
  | { ok: false; reason: OAuthPendingConsumeReason };

// The current (non-secret) row state, for classifying a failed consume into a safe reason. Returns only
// hashes / ids / timestamps — NEVER a raw nonce/state/code/secret.
export type OAuthPendingRowState = {
  tenantId: string;
  provider: string;
  connectorId: string | null;
  nonceHash: string;
  consumedAt: string | null;
  expiresAt: string; // ISO timestamp
};

// The injected runner-identity-backed executor (the privileged DB boundary — NOT reachable from request/
// browser code). A real implementation is wired in a later gated PR (the connector runner), backed by a
// SECURITY-DEFINER accessor / the runner's own connection; `oauth_pending` stays deny-all to anon/auth.
export interface OAuthPendingConsumer {
  // Perform the ONE atomic UPDATE (see the module's reference SQL). Returns the consumed row's SAFE
  // {stateJti, consumedAt} iff exactly one row changed; otherwise null.
  runAtomicConsume(params: {
    tenantId: string;
    provider: string;
    connectorId: string | null;
    stateJti: string;
    nonceHash: string;
    nowIso: string;
  }): Promise<{ stateJti: string; consumedAt: string } | null>;
  // Read-only lookup of the current row state by the unique `state_jti`, to classify a failed consume.
  // Returns null when no such row exists. MUST NOT mutate.
  readPendingState(stateJti: string): Promise<OAuthPendingRowState | null>;
}

export class OAuthPendingConsumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthPendingConsumeError";
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Atomically consume a pending OAuth state EXACTLY ONCE via the injected runner executor. Returns a safe,
// typed result — `{ ok: true, consumed }` only when exactly one matching, unconsumed, unexpired row was
// marked consumed; otherwise `{ ok: false, reason }` with a fixed safe reason code (never a raw input value).
export async function consumeOAuthPending(
  input: OAuthPendingConsumeInput,
  consumer: OAuthPendingConsumer,
): Promise<OAuthPendingConsumeResult> {
  if (!consumer || typeof consumer.runAtomicConsume !== "function" || typeof consumer.readPendingState !== "function")
    throw new OAuthPendingConsumeError("missing oauth_pending consumer");
  // Validate inputs — a bad input is a safe `malformed_input`, never a thrown raw value.
  if (
    !input ||
    typeof input !== "object" ||
    !isNonEmptyString(input.tenantId) ||
    !isNonEmptyString(input.provider) ||
    !isNonEmptyString(input.stateJti) ||
    !isNonEmptyString(input.nonceHash) ||
    !Number.isFinite(input.now) ||
    (input.connectorId != null && typeof input.connectorId !== "string")
  ) {
    return { ok: false, reason: "malformed_input" };
  }
  const connectorId = input.connectorId ?? null;
  const nowIso = new Date(input.now).toISOString();

  // The ONE atomic mutation. Success ⇒ exactly one row changed.
  const consumed = await consumer.runAtomicConsume({
    tenantId: input.tenantId,
    provider: input.provider,
    connectorId,
    stateJti: input.stateJti,
    nonceHash: input.nonceHash,
    nowIso,
  });
  if (consumed) {
    return { ok: true, consumed: { stateJti: consumed.stateJti, consumedAt: consumed.consumedAt } };
  }

  // 0 rows changed — classify WHY (read-only; does not mutate, so single-use is preserved). A state_jti is
  // unique, so there is at most one row to inspect. Identity mismatches are reported before consumed/expired
  // (a wrong tenant/provider/connector/nonce on a known jti is a forgery/confused-deputy signal).
  const row = await consumer.readPendingState(input.stateJti);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.tenantId !== input.tenantId) return { ok: false, reason: "tenant_mismatch" };
  if (row.provider !== input.provider) return { ok: false, reason: "provider_mismatch" };
  if (row.connectorId !== connectorId) return { ok: false, reason: "connector_mismatch" };
  if (row.nonceHash !== input.nonceHash) return { ok: false, reason: "nonce_mismatch" };
  if (row.consumedAt != null) return { ok: false, reason: "already_consumed" };
  if (!(Date.parse(row.expiresAt) > input.now)) return { ok: false, reason: "expired" };
  // Identity matched, unconsumed, unexpired — yet the atomic update changed nothing (e.g. a race that
  // consumed it between the update and this read). Fail closed as already_consumed (never a success).
  return { ok: false, reason: "already_consumed" };
}
