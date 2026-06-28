// Server-only TOKEN-SOURCE SELECTOR (Slack production credential path foundation, PR #198). Chooses which
// `ProviderTokenSource` the Slack sync chain uses, by explicit environment/config — allowlist-shaped + fail-closed.
//
// Rule: the DEV token source is chosen ONLY when `isDevProviderTokenSourceEnabled(env)` (positively-confirmed local dev
// + explicit opt-in). EVERY other environment — unknown/unset/test/staging/preview/production — gets the production-
// shaped VAULT source, which currently fails closed on every call. There is **NO vault→dev fallback**: outside local
// dev the chain can ONLY get the (throwing) vault source, never the dev token. A request can never influence the choice
// (the selector reads the trusted env map only). The vault source becomes a real reader (runner/KMS/vault) in a future
// PR with NO change to callers — see vault-provider-token-source.ts. RISK-007 stays OPEN.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and the static no-client-import scan.

import { createDevProviderTokenSource, isDevProviderTokenSourceEnabled, type ProviderTokenSource } from "./provider-token-source";
import { createVaultProviderTokenSource } from "./vault-provider-token-source";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/provider-token-source-selector is server-only and must not be imported in client code");
}

export function createProviderTokenSource(env: Record<string, string | undefined> = process.env): ProviderTokenSource {
  if (isDevProviderTokenSourceEnabled(env)) return createDevProviderTokenSource(env); // local dev + opt-in ONLY
  return createVaultProviderTokenSource(); // production-shaped; currently fail-closed (no real reader). No dev fallback.
}
