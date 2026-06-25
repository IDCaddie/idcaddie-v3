// Server-only, PURE connector-secret LIFECYCLE AUDIT builder (docs/42 §83, RISK-007 audit scaffolding).
//
// This is the typed, allowlist-based foundation for auditing connector-secret store/load/decrypt lifecycle
// events SAFELY — the audit layer that must exist before any real credential lifecycle. It does NOT execute a
// connector, call a provider, read/write any credential, touch `connector_secrets`, access a database, import a
// Supabase client, use a privileged/admin/service-role path, exchange an OAuth code, or decrypt anything. It
// only VALIDATES lifecycle audit inputs and BUILDS the safe, insert-ready shape a FUTURE server-only writer
// would persist into the append-only `audit_logs` table (action / resource_type / tenant_id / after_json). No
// writer is wired in this PR — the #160 store adapter has no real call sites yet, so there is no real lifecycle
// to emit from. This is audit SCAFFOLDING only.
//
// SCOPE: the store/load/decrypt events (#166/#167) + the revocation/tombstone events (#170, emitted by the
// revoke/tombstone write helpers). Rotation/delete/update events are NOT added — those belong with the behavior
// that emits them, and no rotation/delete/update helper exists yet.
//
// ALLOWLIST, NOT DENYLIST: the builder constructs the audit `after_json` from an EXPLICIT set of permitted
// fields only. It NEVER spreads the input and carries NO arbitrary-metadata passthrough field, so any extra
// property on a (hostile) input — plaintext, a token, ciphertext, a DEK, an AEAD tag/nonce, a KMS response,
// a DB URL, a raw error object — is structurally DROPPED (never read, never in the output). As defense in
// depth, each allowed string value is shape-validated, and the finished `after_json` is re-scanned with the
// shared secret/credential guard so a credential-shaped value cannot ride in through an allowed field.
//
// SERVER-ONLY (same discipline as crypto.ts / run-lifecycle.ts): under `src/lib/server/`, the runtime browser
// sentinel below, and `no-client-import.test.ts`. Its only import is the pure, server-only run-lifecycle guard.

import { ConnectorLifecycleError, assertSafeFailureLabel } from "./run-lifecycle";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/secret-audit is server-only and must not be imported in client code");
}

// ── Supported events: store / load / decrypt (#166/#167) + revocation / tombstone (#170, with the helpers that
//    emit them). Each event is `connector_secret.<op>.<attempted|succeeded|failed>`. `rotation` and
//    `delete`/`update` events are intentionally ABSENT — they are added only when that behavior exists (no
//    rotation helper yet).
export const CONNECTOR_SECRET_AUDIT_EVENTS = [
  "connector_secret.store.attempted",
  "connector_secret.store.succeeded",
  "connector_secret.store.failed",
  "connector_secret.load.attempted",
  "connector_secret.load.succeeded",
  "connector_secret.load.failed",
  "connector_secret.decrypt.attempted",
  "connector_secret.decrypt.succeeded",
  "connector_secret.decrypt.failed",
  // ── #170: the revoke/tombstone WRITE helpers emit these (the rotation events are NOT added — no rotation helper).
  "connector_secret.revocation.attempted",
  "connector_secret.revocation.succeeded",
  "connector_secret.revocation.failed",
  "connector_secret.tombstone.attempted",
  "connector_secret.tombstone.succeeded",
  "connector_secret.tombstone.failed",
] as const;
export type ConnectorSecretAuditEvent = (typeof CONNECTOR_SECRET_AUDIT_EVENTS)[number];

// Result status — DERIVED from the event suffix (never a free-form input).
export type ConnectorSecretAuditResult = "attempted" | "succeeded" | "failed";

// Actor/runtime type — the only runtime permitted to touch connector secrets is the runner (#160). Allowlist.
export const CONNECTOR_SECRET_ACTOR_TYPES = ["connector_runner"] as const;
export type ConnectorSecretActorType = (typeof CONNECTOR_SECRET_ACTOR_TYPES)[number];

// Static error CLASSES allowed on a `.failed` event — a fixed label only, NEVER a raw error/message (which
// could carry secret material). Anything outside this allowlist collapses to "unknown_error".
export const CONNECTOR_SECRET_ERROR_CLASSES = [
  "store_failed",
  "load_failed",
  "decrypt_failed",
  "not_found",
  "ambiguous_match",
  "invalid_envelope",
  "permission_denied",
  "target_not_found", // #170: a revoke/tombstone whose exact (tenant, connector, kind, version) secret does not exist
  "unknown_error",
] as const;
export type ConnectorSecretErrorClass = (typeof CONNECTOR_SECRET_ERROR_CLASSES)[number];

// The INPUT type carries ONLY the allowed fields — no index signature, no `metadata`, no passthrough. This is
// the compile-time half of the allowlist; the runtime half is the explicit field-by-field build below.
export type ConnectorSecretAuditInput = {
  event: ConnectorSecretAuditEvent;
  tenantId: string;
  connectorId: string;
  secretKind: string;
  version: number;
  actorType?: ConnectorSecretActorType;
  /** Only honored on a `.failed` event; coerced to the allowlist; dropped otherwise. */
  errorClass?: ConnectorSecretErrorClass;
  /** Optional request/job/run correlation id (safe-shaped only). */
  correlationId?: string;
};

// The OUTPUT — an insert-ready, fully-allowlisted audit record mapping 1:1 to `audit_logs`:
//   action → action, resourceType → resource_type, tenantId → tenant_id, afterJson → after_json.
// (created_at is owned by the DB default `now()`; the audit layer does NOT own timestamps, so none is emitted.)
export type ConnectorSecretAuditRecord = {
  action: ConnectorSecretAuditEvent;
  resourceType: "connector_secret";
  tenantId: string;
  afterJson: ConnectorSecretAuditAfterJson;
};

export type ConnectorSecretAuditAfterJson = {
  event: ConnectorSecretAuditEvent;
  connector_id: string;
  secret_kind: string;
  version: number;
  result: ConnectorSecretAuditResult;
  actor_type?: ConnectorSecretActorType;
  error_class?: ConnectorSecretErrorClass;
  correlation_id?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Connector secret kinds are short lower-snake tokens (e.g. api_key, oauth_access, oauth_refresh). Bounded +
// charset-restricted so a kind field can never carry a JWT/token/ciphertext/key blob.
const SAFE_KIND_RE = /^[a-z][a-z0-9_]{0,62}$/;
// A correlation id is a uuid OR a short PREFIXED id (run-/job-/req-/corr-/trace-/span-…). Restricting to these
// id grammars — rather than any bounded [A-Za-z0-9_-] token — structurally rejects a high-entropy opaque blob
// (a 64-char hex key, a base64 DEK, key material) that is charset-indistinguishable from a bare id token, so a
// raw secret cannot ride in through the correlation slot even though no named-credential prefix matches it.
const SAFE_CORRELATION_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(run|job|req|corr|trace|span)[-_][A-Za-z0-9][A-Za-z0-9_-]{0,62})$/i;

// Reusable grammar-safe correlation_id guard (same grammar the audit builder enforces) — so callers (e.g. the
// staging ingestion guard) can fail closed on a bad correlation_id BEFORE any store, with the identical rule.
export function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === "string" && SAFE_CORRELATION_RE.test(value);
}

function deriveResult(event: ConnectorSecretAuditEvent): ConnectorSecretAuditResult {
  // The suffix after the last "." is always attempted | succeeded | failed for the supported events.
  const suffix = event.slice(event.lastIndexOf(".") + 1);
  if (suffix === "attempted" || suffix === "succeeded" || suffix === "failed") return suffix;
  // Unreachable for the validated allowlist; fail closed rather than guess.
  throw new ConnectorLifecycleError("unsupported connector secret audit event suffix");
}

// Build a SAFE, allowlisted connector-secret audit record. Reads ONLY the permitted fields from `input`; every
// other property (including any `metadata`, plaintext, token, ciphertext, DEK, AEAD tag/nonce, KMS response, DB
// URL, or raw error) is structurally DROPPED. Fails closed on a missing/malformed allowed field or any
// credential-shaped value. PURE: no DB, no I/O, no time, no randomness.
export function buildConnectorSecretAuditEvent(input: ConnectorSecretAuditInput): ConnectorSecretAuditRecord {
  // 1) event must be one of the supported store/load/decrypt/revocation/tombstone events (rejects rotation/
  //    delete/update and anything else — see CONNECTOR_SECRET_AUDIT_EVENTS).
  if (!(CONNECTOR_SECRET_AUDIT_EVENTS as readonly string[]).includes(input.event))
    throw new ConnectorLifecycleError(`unsupported connector secret audit event: ${String(input.event)}`);

  // 2) identity fields — uuid-shaped, non-empty. A secret-shaped value cannot pass the uuid check.
  if (typeof input.tenantId !== "string" || !UUID_RE.test(input.tenantId))
    throw new ConnectorLifecycleError("invalid tenantId");
  if (typeof input.connectorId !== "string" || !UUID_RE.test(input.connectorId))
    throw new ConnectorLifecycleError("invalid connectorId");

  // 3) secret_kind — bounded lower-snake token only (the kind, never the secret).
  if (typeof input.secretKind !== "string" || !SAFE_KIND_RE.test(input.secretKind))
    throw new ConnectorLifecycleError("invalid secret_kind");

  // 4) version — positive integer.
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new ConnectorLifecycleError("invalid version");

  const result = deriveResult(input.event);

  // 5) actor type — optional; must be in the allowlist if present.
  if (input.actorType !== undefined && !(CONNECTOR_SECRET_ACTOR_TYPES as readonly string[]).includes(input.actorType))
    throw new ConnectorLifecycleError("invalid actor_type");

  // 6) error class — honored ONLY on a `.failed` event; coerced to the allowlist (unknown → "unknown_error");
  //    DROPPED entirely on non-failed events.
  let errorClass: ConnectorSecretErrorClass | undefined;
  if (result === "failed") {
    errorClass =
      input.errorClass !== undefined &&
      (CONNECTOR_SECRET_ERROR_CLASSES as readonly string[]).includes(input.errorClass)
        ? input.errorClass
        : "unknown_error";
  }

  // 7) correlation id — optional; safe-shaped only (fail closed on a bad value rather than silently keep it).
  let correlationId: string | undefined;
  if (input.correlationId !== undefined) {
    if (typeof input.correlationId !== "string" || !SAFE_CORRELATION_RE.test(input.correlationId))
      throw new ConnectorLifecycleError("invalid correlation_id");
    correlationId = input.correlationId;
  }

  // 8) BUILD FRESH from the allowlist — read ONLY the permitted fields; never spread `input`. Any extra
  //    property on `input` is not referenced here and therefore cannot reach the output.
  const afterJson: ConnectorSecretAuditAfterJson = {
    event: input.event,
    connector_id: input.connectorId,
    secret_kind: input.secretKind,
    version: input.version,
    result,
    ...(input.actorType !== undefined ? { actor_type: input.actorType } : {}),
    ...(errorClass !== undefined ? { error_class: errorClass } : {}),
    ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
  };

  // 9) Defense in depth — re-scan every string VALUE in the finished allowlisted object for a credential-shaped
  //    value (belt-and-suspenders over the explicit build above). Keys are a fixed allowlist so only values are
  //    scanned; `secret_kind` is a legitimate field NAME (the kind, not a secret) and must not trip a key check.
  for (const v of Object.values(afterJson)) {
    if (typeof v === "string") assertSafeFailureLabel(v);
  }

  return { action: input.event, resourceType: "connector_secret", tenantId: input.tenantId, afterJson };
}
