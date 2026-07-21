# Okta API Services — Phase 3: remove Model-A cluster + validate runner (evidence)

**Status: the obsolete Authorization Code / PKCE / browser-callback (Model-A) implementation is DELETED; the only Okta connection
model in-tree is API Services (Client Credentials + private_key_jwt). The runner Client Credentials path is validated with
mocks only.** Date 2026-07-20. No secret read, no key signed, no token minted, no Okta API call.

## Removed (Model-A okta-live cluster) — item 5
Deleted 11 modules + 7 tests: `okta-authorize-url`, `okta-oauth-transaction`, `okta-transaction-store`,
`okta-pkce-verifier-store`, `okta-callback-foundation`, `okta-callback-route-handler`, `okta-token-exchange`,
`okta-token-exchange-adapter`, `okta-credential-write`, `okta-connect-gate`, `okta-client-config` (+ their `.test.ts`, incl. the
Model-A `okta-staging-wiring.test.ts`).
- **Preserved** `isValidOktaClientId` — moved into `okta-provider-contract.ts` (the appropriately-named provider-contract module).
- **Reconciled** shared tests: removed the dormant-token-exchange proof from `okta-dormancy.test.ts` (kept the execution-dormancy /
  first-sync / audit / disconnect proofs); removed the OAuth-transaction-record assertions from `okta-credential-boundary.test.ts`
  (kept the credential-reference pointer secret-scan).
- **Fixed** `okta-disconnect-execute.ts` — dropped the `OktaTransactionStore` dependency (API Services has no browser OAuth
  transaction to invalidate on disconnect).

Remaining okta-live modules are the Model-B set only: `okta-provider-contract`, `okta-governance-gate`, `okta-org-validator`,
`okta-config-gate`, `okta-connection-persist`, `okta-connection-state`, `okta-audit-events`, `okta-first-sync-authorization`,
`okta-disconnect`, `okta-disconnect-execute`. No route/UI/DAL implies browser OAuth for Okta.

## Runner Client Credentials validation (mocks only) — item 6
- Full runner Okta suite: **7 files / 106 tests pass** (no network, no secret, no real key).
- `okta-auth.ts` builds `grant_type=client_credentials` + `client_assertion_type=jwt-bearer` with an **injected pre-signed**
  assertion — verified NO real signing / secret-read in the module (`createSign`/`privateKey`/`readFileSync`/`GetSecretValue` = 0).
- Runner remains **non-dispatchable**: Okta is absent from the live `FRAMEWORK_REGISTRY` (0 entries). certificationOnly; the real
  signing + registry registration remain a separate GO.

## Validation
`tsc --noEmit` clean · `eslint` clean · v3 full vitest **1486 passed / 22 skipped / 0 failed** (58 Model-A tests removed) · runner
Okta suite 106 passed.

## Safety
No secret value retrieved; secret contents not inspected; no private key printed; no assertion signed; no token acquired; no Okta
API call; no sync; no schedule; no production access. Okta `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.
