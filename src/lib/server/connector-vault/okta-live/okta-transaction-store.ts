// P5E18b — the OAuth TRANSACTION persistence boundary (Phase 4). Persists ONLY the non-secret OktaOAuthTransactionRecord (state
// nonce HASH, PKCE CHALLENGE — never the raw verifier, never a token/code). Single-use: `consumeOnce` atomically marks a
// transaction consumed and a replay fails closed. Supports expiry, invalidation (with a failure reason code), and an active-lookup.
// The in-memory implementation is the reference/test impl; production backs it with the `oauth_pending` (provider='okta') single-
// use store + the record fields — the raw verifier lives ONLY in the separate transient PKCE store, never here.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import type { OktaOAuthTransactionRecord } from "./okta-oauth-transaction";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-transaction-store is server-only and must not be imported in client code");
}

export type OktaTransactionInvalidateReason = "expired" | "superseded" | "disconnected" | "callback_rejected" | "operator";

export interface OktaTransactionStore {
  create(record: OktaOAuthTransactionRecord): Promise<void>;
  // Atomically consume by correlation id. Returns the record iff it was active (found, not expired, not consumed, not invalidated);
  // otherwise null. A second consume of the same correlation returns null (replay-safe).
  consumeOnce(correlationId: string, now: number): Promise<OktaOAuthTransactionRecord | null>;
  invalidate(correlationId: string, now: number, reason: OktaTransactionInvalidateReason): Promise<void>;
  // Non-consuming active lookup (found + not expired/consumed/invalidated).
  findActive(correlationId: string, now: number): Promise<OktaOAuthTransactionRecord | null>;
}

type Stored = { record: OktaOAuthTransactionRecord; consumedAt: number | null; invalidatedAt: number | null; failureReason: OktaTransactionInvalidateReason | null };

function isActive(s: Stored, now: number): boolean {
  return s.consumedAt === null && s.invalidatedAt === null && s.record.expiresAt > now;
}

// In-memory reference store. Correlation id is the key (unique per transaction).
export function createInMemoryOktaTransactionStore(): OktaTransactionStore {
  const m = new Map<string, Stored>();
  return {
    async create(record) {
      if (!record || typeof record.correlationId !== "string" || record.correlationId.length === 0) throw new Error("record.correlationId required");
      if (m.has(record.correlationId)) throw new Error("duplicate transaction correlationId");
      m.set(record.correlationId, { record, consumedAt: null, invalidatedAt: null, failureReason: null });
    },
    async consumeOnce(correlationId, now) {
      const s = m.get(correlationId);
      if (!s) return null;
      if (!isActive(s, now)) return null; // expired / already consumed / invalidated → fail closed
      s.consumedAt = now;
      return s.record;
    },
    async invalidate(correlationId, now, reason) {
      const s = m.get(correlationId);
      if (!s || s.invalidatedAt !== null) return; // idempotent
      s.invalidatedAt = now;
      s.failureReason = reason;
    },
    async findActive(correlationId, now) {
      const s = m.get(correlationId);
      return s && isActive(s, now) ? s.record : null;
    },
  };
}
