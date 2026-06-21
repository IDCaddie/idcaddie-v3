// Server-only helpers for the OAuth `oauth_pending` single-use replay store (docs/42 §32.3, migration 0020).
//
// PURE + server-only. It does NOT access the database, exchange OAuth codes, store any credential, touch
// `connector_secrets`, import a Supabase client, or use a privileged path. It only HASHES the (single-use,
// not-long-lived) nonce and VALIDATES + BUILDS the safe row shape a FUTURE server-only consume path would
// INSERT into `public.oauth_pending` — the actual DB write/consume is a later gated PR. The vault stays
// NOT usable for real credentials.
//
// WHY a helper: the future consume path must hash the nonce the SAME deterministic way the create path did
// (so a returning callback's nonce hashes to the stored `nonce_hash`). Keeping that hash + the safe-shape
// validation in one tested place — matching crypto.ts / oauth-state.ts discipline — prevents drift.
//
// SAFE-METADATA-ONLY (docs/42 §32.3): the produced record stores NO raw nonce, NO raw `state`, NO
// authorization code, NO token/key/secret — only `nonce_hash` (sha256) + non-secret correlation/metadata.
//
// SERVER-ONLY: lives under `src/lib/server/`, carries the runtime browser sentinel below, and the
// `no-client-import.test.ts` guard asserts no `"use client"` / `src/app` file imports it. Only import is
// `node:crypto`.

import { createHash } from "node:crypto";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-pending is server-only and must not be imported in client code");
}

export class OAuthPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthPendingError";
  }
}

// Deterministic one-way hash for the nonce (and any value the store keeps as a hash, never raw). Same
// input → same sha256 hex; the raw value is never returned or retained.
export function hashOAuthValue(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new OAuthPendingError("value to hash must be a non-empty string");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The input a future create path supplies. `nonce` is the RAW nonce — it is hashed here and NEVER stored
// or returned. `expiresAt` is an ISO timestamp (the row's required short TTL).
export type OAuthPendingInput = {
  tenantId: string;
  provider: string;
  stateJti: string;
  nonce: string;
  intent: string;
  expiresAt: string;
  connectorId?: string | null;
  organizationId?: string | null;
  subject?: string | null;
};

// The safe row a future server-only consume path would INSERT into `public.oauth_pending` (matches the
// 0020 columns). NOTE there is NO `nonce` field — only `nonceHash`. Plaintext nonce/state/code never here.
export type OAuthPendingRecord = {
  tenantId: string;
  provider: string;
  stateJti: string;
  nonceHash: string;
  intent: string;
  expiresAt: string;
  connectorId: string | null;
  organizationId: string | null;
  subject: string | null;
};

// Field names that must NEVER appear on a pending-store input (a raw secret/token/code/nonce/state). The
// helper rejects them so a caller cannot smuggle plaintext into the store.
const FORBIDDEN_KEYS =
  /(^|_)(nonce$|raw|state$|payload|code$|authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|token|ciphertext|pkce|verifier|password)/i;

// Validate the input and return the SAFE record (nonce hashed, raw nonce dropped). Throws OAuthPendingError
// on any invalid/secret-shaped input. Performs NO database write — it only builds the shape.
export function buildOAuthPendingRecord(input: OAuthPendingInput): OAuthPendingRecord {
  if (!input || typeof input !== "object") throw new OAuthPendingError("invalid oauth pending input");
  const reqStr = (v: unknown, field: string): string => {
    if (typeof v !== "string" || v.length === 0) throw new OAuthPendingError(`invalid oauth pending input: ${field}`);
    return v;
  };
  const tenantId = reqStr(input.tenantId, "tenantId");
  const provider = reqStr(input.provider, "provider");
  const stateJti = reqStr(input.stateJti, "stateJti");
  const intent = reqStr(input.intent, "intent");
  const expiresAt = reqStr(input.expiresAt, "expiresAt");
  const nonce = reqStr(input.nonce, "nonce");
  if (Number.isNaN(Date.parse(expiresAt))) throw new OAuthPendingError("invalid oauth pending input: expiresAt");

  // No extra/unexpected key may carry a raw secret/token/code/nonce/state (belt-and-suspenders; the only
  // raw value this helper accepts is `nonce`, which it immediately hashes and never returns).
  for (const k of Object.keys(input)) {
    if (k === "nonce") continue; // the one raw input, hashed below, never stored
    if (FORBIDDEN_KEYS.test(k)) throw new OAuthPendingError(`forbidden secret-like field "${k}" in oauth pending input`);
  }

  return {
    tenantId,
    provider,
    stateJti,
    nonceHash: hashOAuthValue(nonce), // raw nonce hashed here; not retained on the record
    intent,
    expiresAt,
    connectorId: input.connectorId ?? null,
    organizationId: input.organizationId ?? null,
    subject: input.subject ?? null,
  };
}
