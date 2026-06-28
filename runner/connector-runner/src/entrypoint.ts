// connector-runner — the separate deployable's FAIL-CLOSED entrypoint (doc 46 §11; PR #200 skeleton). It implements the
// vendored `ConnectorRunner` seam but loads NO secret: every `run()` returns `{ ok:false, reason:"runner_disabled" }`.
//
// This is the SEPARATE runner deployable skeleton. It is structurally isolated from the app runtime (its own directory +
// tsconfig + test/typecheck commands; the app `src/` never imports it). It contains NO pg / AWS SDK / KMS client /
// Secrets Manager client / vault reader / filesystem secret writer — types only. The production runner (with pg + the
// real KMS/Secrets-Manager + `connector_runner_login` + its own host, §11.1/§11.3) is future work; this skeleton MUST
// NOT gain those until that decision + RISK-007 closure. NOT browser-reachable, NOT a route.

import type { ConnectorRunner, RunnerRequest, RunnerResult, RunnerReason, RunnerProvider } from "./contract";

const RUNNER_OPT_IN = "ID_CADDIE_CONNECTOR_RUNNER_ENABLED"; // a FUTURE approved flag — no effect in this skeleton.

// ALLOWLIST-shaped, ALWAYS false in this skeleton: there is no provisioned/verified production runner host, no prod
// KMS/IAM, no Secrets Manager wiring, no first-real-token (doc 46 §11/§12, docs 44/45). `productionRunnerProvisioned`
// is hardcoded false, so even with the opt-in set this returns false. It reads the TRUSTED env map ONLY — a request can
// never enable it. RISK-007 stays OPEN.
export function isConnectorRunnerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const optIn = env[RUNNER_OPT_IN] === "1";
  const productionRunnerProvisioned = false; // no host / prod KMS-IAM / Secrets Manager / first-real-token — never set here
  return optIn && productionRunnerProvisioned;
}

// PURE non-secret request validation (safe static reasons; never echoes a value).
export function validateRunnerRequest(request: RunnerRequest): { ok: true } | { ok: false; reason: RunnerReason } {
  if (!request || request.provider !== "slack") return { ok: false, reason: "unsupported_provider" };
  if (request.purpose !== "ingest_client_secret") return { ok: false, reason: "unsupported_purpose" };
  if (typeof request.tenantId !== "string" || request.tenantId.length === 0) return { ok: false, reason: "missing_tenant" };
  if (typeof request.connectorId !== "string" || request.connectorId.length === 0) return { ok: false, reason: "missing_connector" };
  if (request.appEnv !== "staging") return { ok: false, reason: "invalid_app_env" };
  if (!Number.isInteger(request.version) || request.version < 1) return { ok: false, reason: "invalid_version" };
  return { ok: true };
}

// The fail-closed runner. `run()` loads NO token, instantiates NO pg/KMS/AWS/Secrets-Manager, logs NO request fields,
// and returns a safe static reason only.
export function createConnectorRunner(env: Record<string, string | undefined> = process.env): ConnectorRunner {
  return {
    async run(request: RunnerRequest): Promise<RunnerResult> {
      const provider: RunnerProvider = "slack";
      if (!isConnectorRunnerEnabled(env)) return { ok: false, reason: "runner_disabled", provider }; // always, today
      const valid = validateRunnerRequest(request); // dead path today (guard above is always false); forward-correct
      if (!valid.ok) return { ok: false, reason: valid.reason, provider };
      return { ok: false, reason: "runner_disabled", provider }; // no real ingest in the skeleton — the real runner does it
    },
  };
}

// CLI-shaped main (the deployable's entry). It prints ONLY a safe static line and exits non-zero while disabled — never
// a token/secret/request field. (Wired to nothing that runs in production; no Docker/ECS deploy here.)
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  void argv; // accepts no secret args; the real runner reads the secret from Secrets Manager, never argv
  const result = await createConnectorRunner().run({
    provider: "slack", tenantId: "", connectorId: "", purpose: "ingest_client_secret",
    secretKind: "oauth_client_secret", appEnv: "staging", version: 1,
  });
  console.log(`connector-runner: ${result.ok ? "ok" : `disabled (${result.reason})`}`); // safe static line only
  return result.ok ? 0 : 1;
}
