// Server-only RUNNER-ONLY connector-secret DECRYPT/USE harness (docs/44 §7 "PR C" — the read/use half of the vault,
// RISK-007 closure path). It composes the EXISTING primitives — the runner-only `RunnerDecryptCapability`
// (secret-vault.ts, forge-proof module-private token), `loadConnectorSecret` (AAD-bound decrypt of a `connector_secrets`
// envelope row through the runner read store), and `RedactedSecret` — into a single "decrypt a stored connector secret,
// USE it, and return ONLY a redacted proof" flow.
//
// SAFE BY CONSTRUCTION:
//   * Runner-only: the entrypoint REQUIRES a `RunnerDecryptCapability`, which request/web-path code cannot construct
//     (module-private token) and cannot acquire (`acquireRunnerDecryptCapability` returns null without the runner
//     runtime marker). So there is no way to call this from a route/component/browser bundle.
//   * The plaintext NEVER leaves the harness: it is exposed (via `RedactedSecret.expose()`) ONLY to compute a
//     non-reversible fingerprint + byte length and to hand to an injected, runner-only `use` callback whose result is
//     constrained to non-secret fields. The RETURN VALUE is a `DecryptUseProof` — identifiers + a sha256 fingerprint +
//     byte length + the use result — and NEVER the plaintext, ciphertext, DEK, or `RedactedSecret` itself.
//   * Fail-closed: any load/decrypt/use failure (not-found / inactive-revoked / malformed envelope / wrong AAD / bad
//     capability) throws a typed, redacted `ConnectorSecretDecryptUseError` whose message is a fixed safe string or a
//     known-safe vault error message — never the caught error body, plaintext, or key material.
//
// This performs NO AWS call, NO OAuth exchange, NO provider API call, and stores/decrypts NO real secret on its own —
// the KMS-backed key provider + the real runner read store are INJECTED by the runner entrypoint on an approved run.
// RISK-007 remains OPEN; Phase C remains BLOCKED.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { createHash } from "node:crypto";
import { ConnectorVaultCryptoError, type SecretContext, type SecretKind } from "./crypto";
import {
  ConnectorSecretVaultError,
  RedactedSecret,
  RunnerDecryptCapability,
  loadConnectorSecret,
  type ConnectorSecretReadStore,
} from "./secret-vault";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/connector-secret-decrypt-use is server-only and must not be imported in client code");
}

// A typed, safe-to-surface error. Its message is a fixed safe string (or a known-safe vault error message) — never
// plaintext, ciphertext, key material, or a raw caught error body.
export class ConnectorSecretDecryptUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSecretDecryptUseError";
  }
}

// The result of the injected runner-only `use` callback. It MUST be non-secret: `ok` is a boolean and `detail` is a
// short non-secret note (e.g. an HTTP status class). The harness passes through ONLY these two fields.
export type DecryptUseResult = { ok: boolean; detail?: string };

// The REDACTED proof returned to the (possibly request-path-initiated) caller. Identifiers + a NON-REVERSIBLE
// fingerprint + byte length + the use result. NO plaintext, NO ciphertext, NO DEK, NO `RedactedSecret`.
export type DecryptUseProof = {
  ok: true;
  tenantId: string;
  connectorId: string;
  secretKind: SecretKind;
  version: number;
  kekId: string; // non-secret KEK handle (echoed from the caller)
  plaintextByteLength: number;
  // sha256(plaintext) hex — proves the decrypted secret's IDENTITY (an operator can match it against a known secret's
  // fingerprint) WITHOUT exposing it. Never the secret.
  // ponytail: unsalted sha256 is non-reversible for the HIGH-ENTROPY credential kinds this vault stores (provider-issued
  // OAuth access/refresh tokens, API keys, PATs). If a LOW-entropy operator-chosen kind is ever added, switch to a
  // server-keyed HMAC — an unsalted fingerprint + exact byteLength would otherwise be offline-brute-forceable for it.
  fingerprint: string;
  use: DecryptUseResult | null;
};

function safeReason(e: unknown): string {
  // The vault's own errors carry a small fixed set of safe, redacted messages — preserve them for diagnosability;
  // anything else collapses to a single static message so a caught error body can never surface.
  if (e instanceof ConnectorVaultCryptoError || e instanceof ConnectorSecretVaultError) return e.message;
  return "connector secret decrypt/use failed";
}

// Runner-only: decrypt a `connector_secrets` envelope row and USE it, returning ONLY a redacted proof.
// Requires a `RunnerDecryptCapability` (request/web-path code cannot obtain one). The AAD binds the context, so a row
// sealed for a different tenant/connector/kind/version fails closed. The injected read store returns the active,
// non-expired row only (a revoked/inactive/absent row -> not found -> fail closed).
export async function runnerDecryptAndUse(
  capability: RunnerDecryptCapability,
  input: {
    context: SecretContext;
    store: ConnectorSecretReadStore;
    kekId: string;
    // Runner-only "use" of the decrypted secret (e.g. a provider API call). Its result MUST be non-secret. The
    // RedactedSecret it receives redacts on string/JSON/inspect; reach the bytes only via `.expose()` and never log them.
    use?: (secret: RedactedSecret) => Promise<DecryptUseResult> | DecryptUseResult;
  },
): Promise<DecryptUseProof> {
  // Structural runner-only gate: a forged/absent capability fails closed BEFORE any store read.
  if (!(capability instanceof RunnerDecryptCapability))
    throw new ConnectorSecretDecryptUseError("decrypt/use requires a runner-only capability");

  const { context, store, kekId } = input;

  let secret: RedactedSecret;
  try {
    secret = await loadConnectorSecret(capability, { context, store });
  } catch (e) {
    throw new ConnectorSecretDecryptUseError(safeReason(e));
  }

  // Expose the bytes ONLY to derive non-secret proof + hand to the runner-only `use`. Never returned/logged; wiped after.
  const bytes = secret.expose();
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const plaintextByteLength = bytes.length;

  let use: DecryptUseResult | null = null;
  try {
    if (input.use) {
      let r: DecryptUseResult;
      try {
        r = await input.use(secret);
      } catch {
        throw new ConnectorSecretDecryptUseError("connector secret use failed");
      }
      // Pass through ONLY the constrained non-secret fields.
      use = { ok: !!(r && r.ok), ...(r && typeof r.detail === "string" ? { detail: r.detail } : {}) };
    }
  } finally {
    // defense-in-depth: wipe the exposed plaintext once the fingerprint + use are done (matches crypto.ts DEK hygiene).
    bytes.fill(0);
  }

  return {
    ok: true,
    tenantId: context.tenantId,
    connectorId: context.connectorId,
    secretKind: context.secretKind,
    version: context.version,
    kekId,
    plaintextByteLength,
    fingerprint,
    use,
  };
}
