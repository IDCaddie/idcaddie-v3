// P5E18b — the TRANSIENT PKCE VERIFIER store (Phase 4). The PKCE code_verifier is a SECRET. This store keeps it server-side ONLY,
// with a SHORT TTL, AUTOMATIC EXPIRY, and ONE-TIME CONSUMPTION. It is NEVER placed in a browser-readable cookie/URL, an audit
// event, an ordinary application table, or a log. `takeOnce` deletes on read (replay-safe). The in-memory implementation here is
// the reference/test impl bounded to the transaction lifetime; production backs it with a tightly-scoped encrypted server-only
// transient store (deferred) with the same contract — no client reads, no logs, no backup beyond the transaction lifetime.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-pkce-verifier-store is server-only and must not be imported in client code");
}

const MAX_TTL_MS = 10 * 60 * 1000; // hard cap: a verifier never lives longer than the OAuth transaction

export interface OktaPkceVerifierStore {
  // Store the verifier for a transaction with a bounded TTL. Overwriting an existing entry is allowed (re-initiation).
  put(transactionId: string, verifier: string, opts: { now: number; ttlMs: number }): void;
  // Return AND DELETE the verifier (one-time). Returns null if absent or expired (expired entries are also deleted).
  takeOnce(transactionId: string, now: number): string | null;
  // Explicitly drop a transaction's verifier (e.g. on invalidation/disconnect).
  invalidate(transactionId: string): void;
}

// In-memory reference store. Bounded, one-time, expiring. Deliberately does NOT log or expose values.
export function createInMemoryPkceVerifierStore(): OktaPkceVerifierStore {
  const m = new Map<string, { verifier: string; expiresAt: number }>();
  return {
    put(transactionId, verifier, opts) {
      if (typeof transactionId !== "string" || transactionId.length === 0) throw new Error("transactionId required");
      if (typeof verifier !== "string" || verifier.length === 0) throw new Error("verifier required");
      if (!Number.isFinite(opts.now)) throw new Error("now required");
      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) throw new Error("ttlMs must be positive");
      const ttl = Math.min(opts.ttlMs, MAX_TTL_MS);
      m.set(transactionId, { verifier, expiresAt: opts.now + ttl });
    },
    takeOnce(transactionId, now) {
      const e = m.get(transactionId);
      if (!e) return null;
      m.delete(transactionId); // one-time: delete regardless of expiry
      if (!(e.expiresAt > now)) return null; // expired → treated as absent
      return e.verifier;
    },
    invalidate(transactionId) {
      m.delete(transactionId);
    },
  };
}
