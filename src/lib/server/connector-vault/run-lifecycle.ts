// Server-only connector RUN/AUDIT lifecycle model (docs/42 §9/§10, gated sequence PR D).
//
// This is the typed, PURE foundation for tracking connector runs + audit events safely — the model that
// must exist before any connector execution or credential storage. It does NOT execute a connector, call
// a provider, read/write any credential, touch `connector_secrets`, access a database, import a Supabase
// client, or use a privileged/admin path. It only VALIDATES lifecycle inputs and BUILDS the safe shapes a
// FUTURE server-only runner would persist (the actual writes are later, server-only/runner work).
//
// SERVER-ONLY (same discipline as crypto.ts): it lives under `src/lib/server/`, carries the runtime
// browser sentinel below, and `no-client-import.test.ts` asserts no `"use client"` / `src/app` file imports
// it. It has NO imports (pure TS) — no DB, no Supabase, no service-role, no `process.env`.
//
// SAFE METADATA ONLY (docs/42 §9/§11): a run/audit record may carry only a status, timestamps, non-negative
// counters, a machine failure CODE and a SAFE human label — never a secret, token, key, or raw provider
// payload. The validators here FAIL CLOSED on any secret-shaped field name or credential-shaped value.

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/run-lifecycle is server-only and must not be imported in client code");
}

// ── Run states (docs/42 §9) ──────────────────────────────────────────────────────────────────────────
export const CONNECTOR_RUN_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
] as const;
export type ConnectorRunStatus = (typeof CONNECTOR_RUN_STATES)[number];

export const TERMINAL_RUN_STATES = ["succeeded", "failed", "canceled", "timed_out"] as const;
export function isTerminalRunStatus(s: ConnectorRunStatus): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(s);
}

// The only allowed forward transitions. Terminal states have no outgoing transition (a run never leaves a
// terminal state). queued/running may be canceled; running may also succeed/fail/time out.
const RUN_TRANSITIONS: Record<ConnectorRunStatus, readonly ConnectorRunStatus[]> = {
  queued: ["running", "canceled"],
  running: ["succeeded", "failed", "canceled", "timed_out"],
  succeeded: [],
  failed: [],
  canceled: [],
  timed_out: [],
};

export function isValidRunTransition(from: ConnectorRunStatus, to: ConnectorRunStatus): boolean {
  return (RUN_TRANSITIONS[from] ?? []).includes(to);
}

// ── Audit actions (docs/42 §10 — recorded into the append-only audit_logs by a FUTURE server writer) ───
export const CONNECTOR_AUDIT_ACTIONS = [
  "connector.run.created",
  "connector.run.started",
  "connector.run.completed",
  "connector.run.failed",
  "connector.credential.created",
  "connector.credential.revoked",
] as const;
export type ConnectorAuditAction = (typeof CONNECTOR_AUDIT_ACTIONS)[number];

export class ConnectorLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorLifecycleError";
  }
}

// ── Redaction guards (docs/42 §11) ─────────────────────────────────────────────────────────────────────
// A field NAME that looks secret-bearing is forbidden in any safe run/audit metadata. (Matches the design
// §11 deny-list: token/secret/key/credential/refresh/access/authorization/cookie/ciphertext/dek/kek/pat…)
const FORBIDDEN_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|refresh|access[_-]?token|authorization|cookie|credential|ciphertext|dek|kek|private[_-]?key|client[_-]?secret|webhook[_-]?secret|\bpat\b)/i;

// A VALUE that looks like a real credential (JWT / common token prefixes / bearer). Belt-and-suspenders so
// a credential cannot sneak in through an innocuously-named field (e.g. a failure label). UNANCHORED +
// case-insensitive on purpose: it must catch a credential ANYWHERE in the string (e.g. a raw provider
// error like "upstream 401: Bearer ghp_… expired"), not only as the leading token.
const CREDENTIAL_VALUE_RE =
  /(eyJ[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9]{12,}|bearer\s+\S+)/i;

// Throw if any key looks secret-bearing or any string value looks like a credential. `where` is a safe label.
export function assertNoSecretFields(obj: Record<string, unknown>, where: string): void {
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEY_RE.test(k))
      throw new ConnectorLifecycleError(`forbidden secret-like field "${k}" in ${where}`);
    if (typeof v === "string" && CREDENTIAL_VALUE_RE.test(v))
      throw new ConnectorLifecycleError(`field "${k}" in ${where} looks like a credential value`);
  }
}

// A failure label must be a SHORT, SAFE human string — no credential-shaped content, bounded length.
export function assertSafeFailureLabel(label: string): void {
  if (typeof label !== "string") throw new ConnectorLifecycleError("failure label must be a string");
  if (label.length > 200) throw new ConnectorLifecycleError("failure label too long (max 200 chars)");
  if (CREDENTIAL_VALUE_RE.test(label.trim()))
    throw new ConnectorLifecycleError("failure label looks like a credential value");
}

// ── Builders (PURE — return the safe shape a future server-only writer would persist; NO DB access) ────
function assertSafeCount(n: unknown, field: string): void {
  if (n === undefined) return;
  if (!Number.isInteger(n) || (n as number) < 0)
    throw new ConnectorLifecycleError(`${field} must be a non-negative integer`);
}

// The safe run row a runner would INSERT/UPDATE into connector_runs (matches the 0019 columns). No secret,
// no provider payload — only validated lifecycle metadata. Returns the shape; performs NO database write.
export type ConnectorRunRecordInput = {
  tenantId: string;
  connectorId: string;
  status: ConnectorRunStatus;
  startedAt?: string;
  completedAt?: string;
  failureCode?: string;
  failureLabel?: string;
  recordsSeen?: number;
  recordsImported?: number;
  recordsFailed?: number;
};

export function buildConnectorRunRecord(input: ConnectorRunRecordInput): ConnectorRunRecordInput {
  if (typeof input.tenantId !== "string" || input.tenantId.length === 0)
    throw new ConnectorLifecycleError("invalid tenantId");
  if (typeof input.connectorId !== "string" || input.connectorId.length === 0)
    throw new ConnectorLifecycleError("invalid connectorId");
  if (!(CONNECTOR_RUN_STATES as readonly string[]).includes(input.status))
    throw new ConnectorLifecycleError(`invalid run status: ${String(input.status)}`);
  assertSafeCount(input.recordsSeen, "recordsSeen");
  assertSafeCount(input.recordsImported, "recordsImported");
  assertSafeCount(input.recordsFailed, "recordsFailed");
  // Both the machine failure CODE and the human failure LABEL are bounded + credential-scanned (the code
  // is the field a runner is most likely to stamp a raw provider auth error into).
  if (input.failureCode !== undefined) assertSafeFailureLabel(input.failureCode);
  if (input.failureLabel !== undefined) assertSafeFailureLabel(input.failureLabel);
  // No secret-shaped field may appear anywhere on the input (incl. a credential-shaped failureCode/label).
  assertNoSecretFields(input as Record<string, unknown>, "connector run record");
  return {
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    failureCode: input.failureCode,
    failureLabel: input.failureLabel,
    recordsSeen: input.recordsSeen,
    recordsImported: input.recordsImported,
    recordsFailed: input.recordsFailed,
  };
}

// The safe audit event a future server writer would append to audit_logs. Metadata is safe-only.
export type ConnectorAuditEventInput = {
  action: ConnectorAuditAction;
  tenantId: string;
  connectorId: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export function buildConnectorAuditEvent(input: ConnectorAuditEventInput): {
  action: ConnectorAuditAction;
  tenantId: string;
  connectorId: string;
  metadata: Record<string, string | number | boolean | null>;
} {
  if (!(CONNECTOR_AUDIT_ACTIONS as readonly string[]).includes(input.action))
    throw new ConnectorLifecycleError(`invalid connector audit action: ${String(input.action)}`);
  if (typeof input.tenantId !== "string" || input.tenantId.length === 0)
    throw new ConnectorLifecycleError("invalid tenantId");
  if (typeof input.connectorId !== "string" || input.connectorId.length === 0)
    throw new ConnectorLifecycleError("invalid connectorId");
  const metadata = input.metadata ?? {};
  assertNoSecretFields(metadata, "connector audit metadata");
  return { action: input.action, tenantId: input.tenantId, connectorId: input.connectorId, metadata };
}
