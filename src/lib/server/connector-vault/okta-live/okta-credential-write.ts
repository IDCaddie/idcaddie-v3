// P5E18b — the CREDENTIAL-WRITE boundary (Phase 7). Accepts a validated token-exchange result and writes secret material to the
// approved staging secret store via a WRITE-ONLY interface, then persists ONLY a credential REFERENCE + non-secret metadata to the
// application DB. It is idempotent, atomic (rolls back the secret if the DB reference write fails; does not persist a reference if
// the secret write fails), versioned, and carries a revocation marker path. NO secret value is logged; NO complete ARN/reference
// is returned to a customer. NO real secret body is created in this phase — the sinks are injected and unimplemented.
//
// SERVER-ONLY: under src/lib/server/, the runtime browser sentinel below, and no-client-import.test.ts.

import { OKTA_PROVIDER_ID, OKTA_APPROVED_SCOPES, scopesExactlyApproved } from "./okta-provider-contract";
import type { VaultBoundAccessTokenRef } from "./okta-token-exchange";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-live/okta-credential-write is server-only and must not be imported in client code");
}

// WRITE-ONLY secret store: put returns a POINTER (ref + version); markRevoked flips a revocation marker. NO getSecretValue, NO
// read-after-write of the secret VALUE. Least-privilege, staging-named. NO real implementation in this phase.
export interface OktaSecretStoreWriter {
  putSecret(input: { namespace: string; name: string; tokenRef: VaultBoundAccessTokenRef; correlationId: string }): Promise<{ credentialSecretRef: string; credentialVersion: string }>;
  markRevoked(input: { credentialSecretRef: string; credentialVersion: string }): Promise<void>;
}

// The app-DB reference writer (server-only privileged write path). Persists ONLY the reference + non-secret metadata. NO secret value.
export interface OktaCredentialReferenceWriter {
  putReference(row: OktaCredentialReferenceRow): Promise<void>;
}

// The EXACT non-secret row the app DB receives — a pointer + metadata, never a token/secret/code/verifier.
export type OktaCredentialReferenceRow = {
  provider: typeof OKTA_PROVIDER_ID;
  organizationId: string;
  connectionId: string;
  issuerUrl: string;
  credentialSecretRef: string; // external-store POINTER
  credentialVersion: string;
  approvedScopes: readonly string[];
  expiresAt: number | null; // NON-secret expiry metadata
  status: "connected_unsynced";
  createdAt: number;
  updatedAt: number;
};

export type OktaCredentialWriteInput = {
  organizationId: string;
  connectionId: string;
  issuerUrl: string;
  tokenRef: VaultBoundAccessTokenRef;
  grantedScopes: readonly string[];
  expiresInSeconds: number;
  correlationId: string;
  now: number;
  secretNamespace: string; // staging-only namespace, e.g. "idcaddie/staging/connector/okta"
};

export type OktaCredentialWriteResult =
  | { ok: true; credentialVersion: string } // NOTE: never the full ref — only the non-secret version is surfaced
  | { ok: false; reason: "invalid_input" | "scope_not_exact" | "secret_write_failed" | "reference_write_failed_rolled_back" | "reference_write_failed_rollback_failed" };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Write the credential: secret first (get a ref), then the DB reference; roll the secret back if the DB write fails. Idempotency is
// the caller's connection+correlation scope (the DB reference has a unique constraint per connection+provider). NO secret is logged;
// the return exposes only the non-secret version.
export async function writeOktaCredential(
  input: OktaCredentialWriteInput,
  deps: { secretStore: OktaSecretStoreWriter; referenceWriter: OktaCredentialReferenceWriter },
): Promise<OktaCredentialWriteResult> {
  if (!nonEmpty(input.organizationId) || !nonEmpty(input.connectionId) || !nonEmpty(input.issuerUrl) || !nonEmpty(input.tokenRef) || !nonEmpty(input.secretNamespace) || !nonEmpty(input.correlationId)) {
    return { ok: false, reason: "invalid_input" };
  }
  if (scopesExactlyApproved(input.grantedScopes).ok !== true) return { ok: false, reason: "scope_not_exact" };
  if (!(input.expiresInSeconds > 0)) return { ok: false, reason: "invalid_input" };

  // 1. write the secret material to the external store → a POINTER (ref + version). Fail closed on error.
  let ref: { credentialSecretRef: string; credentialVersion: string };
  try {
    ref = await deps.secretStore.putSecret({ namespace: input.secretNamespace, name: `${input.connectionId}`, tokenRef: input.tokenRef, correlationId: input.correlationId });
  } catch {
    return { ok: false, reason: "secret_write_failed" };
  }

  // 2. persist ONLY the reference + non-secret metadata to the app DB. On failure, ROLL BACK the secret (mark revoked).
  const row: OktaCredentialReferenceRow = {
    provider: OKTA_PROVIDER_ID,
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    issuerUrl: input.issuerUrl,
    credentialSecretRef: ref.credentialSecretRef,
    credentialVersion: ref.credentialVersion,
    approvedScopes: [...OKTA_APPROVED_SCOPES],
    expiresAt: input.now + input.expiresInSeconds * 1000,
    status: "connected_unsynced",
    createdAt: input.now,
    updatedAt: input.now,
  };
  try {
    await deps.referenceWriter.putReference(row);
  } catch {
    try {
      await deps.secretStore.markRevoked({ credentialSecretRef: ref.credentialSecretRef, credentialVersion: ref.credentialVersion });
      return { ok: false, reason: "reference_write_failed_rolled_back" };
    } catch {
      return { ok: false, reason: "reference_write_failed_rollback_failed" }; // needs operator reconciliation
    }
  }
  return { ok: true, credentialVersion: ref.credentialVersion }; // never returns the full ref
}
