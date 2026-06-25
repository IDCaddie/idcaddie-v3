// Server-only STAGING-ONLY connector-secret INGESTION guard (PR B1 — RISK-007, docs/44 §2/§7).
//
// The SMALLEST guarded entry that encrypts + stores a connector secret through the EXISTING vault
// (`saveConnectorSecret`). B1 is **SYNTHETIC-ONLY**: it is exercised solely by synthetic sentinel tests. It does
// NOT run a real token, has NO operator/admin-console paste path, NO OAuth exchange, NO Slack API call, NO callback
// route, NO live connector, and NO decrypt. The FIRST real-token event is deferred to **B2** (the server-side Slack
// `oauth.v2.access` exchange — the token is born inside the trusted server/runner path and immediately encrypted;
// no human ever sees/copies/pastes/submits it). **Merging B1 does NOT authorize a real-token run.**
//
// FAIL-CLOSED guards, in order — if ANY fails, NOTHING is stored (no `connector_secrets` row, no succeeded audit)
// and a STATIC error is thrown (never echoing the plaintext / a raw cause):
//   (1) PRODUCTION HARD-BLOCK — refuse unless the trusted server env is an explicit staging/test opt-in.
//   (2) provider/kind allowlist — Slack dev-workspace bot OAuth access token ONLY (docs/44 §1).
//   (3) required identity — tenant_id, connector_id (uuid), version (positive int).
//   (4) grammar-safe correlation_id (the §82/#166 grammar).
//   (5) encrypt-immediately + atomic store + audit via `saveConnectorSecret` (encrypt-only provider; the secret row
//       commits only if its `store.succeeded` audit commits). The plaintext is encrypted then de-referenced; only a
//       REDACTED `SavedSecretRef` (ids + KEK handle) is returned — never plaintext / ciphertext / wrapped DEK.
//
// PLAINTEXT HANDLING (docs/44 §2): this wrapper NEVER logs, echoes, serializes, traces, or returns the plaintext.
// It receives the plaintext as a function argument and hands it straight to the encrypt call — there is no logger /
// tracer / serializer / body-parser between receipt and encryption here (B1 has NO HTTP route; the request-receipt
// observer analysis lands with B2's callback route). As documented in docs/44 §2 step 7, the live reference is
// dropped after encrypt but the JS string/Buffer is NOT wiped — V8 heap residual remains until GC (NOT a hard wipe).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { saveConnectorSecret, type SavedSecretRef, type EncryptOnlyKeyProvider, type ConnectorSecretWriteStore } from "./secret-vault";
import { isSafeCorrelationId } from "./secret-audit";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/connector-secret-ingest is server-only and must not be imported in client code");
}

// The ONLY allowed first credential (docs/44 §1): a Slack dev-workspace bot OAuth access token.
export const ALLOWED_INGEST_PROVIDER = "slack" as const;
export const ALLOWED_INGEST_CREDENTIAL_KIND = "slack_bot_access_token" as const;
// …which is stored as the crypto SecretKind `oauth_access_token` (→ DB `oauth_access`).
const INGEST_CRYPTO_SECRET_KIND = "oauth_access_token" as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Typed, safe-to-surface errors — messages are always fixed static strings (never plaintext / a raw cause).
export class ProductionIngestionBlockedError extends Error {
  constructor() {
    super("connector secret ingestion is staging-only and is hard-blocked outside an explicit staging opt-in");
    this.name = "ProductionIngestionBlockedError";
  }
}
export class ConnectorSecretIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSecretIngestError";
  }
}

// PRODUCTION HARD-BLOCK (trusted server-side signal — NOT request data, so a caller cannot spoof it). Allowed ONLY
// when an explicit staging opt-in flag is set AND the deployment is not a production environment. Fail-closed: any
// unknown/unset/production state returns false. (B2's route MUST resolve the env from this same trusted signal.)
export function isStagingIngestEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production") return false; // never in production
  return env.CONNECTOR_VAULT_STAGING_INGEST_ENABLED === "1"; // explicit opt-in required (default off)
}

export type StagingConnectorSecretIngestInput = {
  provider: string;
  credentialKind: string;
  tenantId: string;
  connectorId: string;
  version: number; // explicit, monotonic — a new credential is a NEW version; B1 does not auto-compute it
  correlationId: string;
  plaintext: string | Buffer; // SYNTHETIC sentinel in B1 tests; a real token is NEVER run through B1
};

export type StagingConnectorSecretIngestDeps = {
  keyProvider: EncryptOnlyKeyProvider;
  kekId: string;
  store: ConnectorSecretWriteStore;
};

// The guarded staging-only ingestion. Returns a REDACTED SavedSecretRef on success; THROWS (fail-closed) on any
// guard / encrypt / store / audit failure with no secret row committed.
export async function ingestStagingConnectorSecret(
  input: StagingConnectorSecretIngestInput,
  deps: StagingConnectorSecretIngestDeps,
): Promise<SavedSecretRef> {
  // (1) PRODUCTION HARD-BLOCK.
  if (!isStagingIngestEnvironment()) throw new ProductionIngestionBlockedError();

  // (2) provider/kind allowlist — Slack dev-workspace bot token ONLY.
  if (input.provider !== ALLOWED_INGEST_PROVIDER || input.credentialKind !== ALLOWED_INGEST_CREDENTIAL_KIND)
    throw new ConnectorSecretIngestError("unsupported connector credential for staging ingestion (Slack bot token only)");

  // (3) required identity fields.
  if (!UUID_RE.test(input.tenantId)) throw new ConnectorSecretIngestError("invalid tenant_id");
  if (!UUID_RE.test(input.connectorId)) throw new ConnectorSecretIngestError("invalid connector_id");
  if (!Number.isInteger(input.version) || input.version < 1) throw new ConnectorSecretIngestError("invalid version");

  // (4) grammar-safe correlation_id (same grammar the audit builder enforces).
  if (!isSafeCorrelationId(input.correlationId)) throw new ConnectorSecretIngestError("invalid correlation_id");

  // (5) encrypt-immediately + atomic store + audit. The plaintext is handed straight to the encrypt path and never
  //     logged/echoed; only a redacted ref is returned. saveConnectorSecret throws a static, redacted error on any
  //     encrypt/store/audit failure (no secret row without its audit; no compensating DELETE).
  return saveConnectorSecret({
    plaintext: input.plaintext,
    context: {
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      secretKind: INGEST_CRYPTO_SECRET_KIND,
      version: input.version,
    },
    keyProvider: deps.keyProvider,
    kekId: deps.kekId,
    store: deps.store,
    correlationId: input.correlationId,
  });
}
