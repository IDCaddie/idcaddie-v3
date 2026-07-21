# Okta API Services — Phase 1 model correction (evidence)

**Status: Okta is corrected to the OAuth 2.0 API Services + Client Credentials + private_key_jwt service model.** No browser
OAuth, no `/authorize`, no PKCE, no callback, no consent redirect, no refresh token. The durable credential is the signing key
(AWS Secrets Manager, runner-read); short-lived tokens are minted inside the runner and discarded. This matches the runner
(`idcaddie-connector-runner/src/connector-sync/okta-auth.ts` builds `grant_type=client_credentials`) and
`idcaddie-connector-runner/docs/OKTA_AUTHENTICATION_DESIGN.md` (the decided model). Date 2026-07-20.

## Removed (browser-OAuth activation)
- **Deleted** `src/app/(authenticated)/connectors/oauth/okta/callback/route.ts` — the Okta browser-OAuth callback endpoint. The
  whole Okta OAuth route tree is gone (no `/connectors/oauth/okta/...` route remains).
- Rewrote `docs/runbooks/OKTA_STAGING_APP_SETUP.md` to the API Services operator checklist.

## Reframed (customer-facing, no browser OAuth)
- `okta-connect-wizard.tsx` → an **API Services configuration guide**: Instructions → Organization (→ issuer) → Configuration
  (client ID + declared key/scope/role completions) → Review → **Verification pending**. No Authorize/Continue-to-Okta/redirect/
  consent/refresh wording. Collects only non-secret metadata; never a private key, token, assertion, secret, or full ARN.
- New connection state **`verification_pending`** (`catalog-types.ts`, `demo-store.ts`), rendered in `view.ts`,
  `connector-status-view.tsx`, `connector-detail-cta.tsx`. Okta is **never** shown as connected/active/connected_unsynced until a
  separately authorized real client-credentials verification succeeds. Customer message: "Your Okta service application
  configuration has been saved. ID Caddie has not yet verified the connection or imported any data."
- Provider-neutral **`onboardingMode`** classification (`oauth_installation | service_application | delegated_oauth |
  static_credential | manual_enterprise_setup`); **Okta = `service_application`** (`catalog.ts`). Minimal — no wizard engine.

## Deferred (Model-A server-only cluster — obsolete for Okta, NOT activated, pending deletion in a focused followup)
These dormant `src/lib/server/connector-vault/okta-live/` modules implement the wrong (Authorization Code / PKCE / browser
callback) model. They are server-only, unreferenced by any route/UI, and not activated. Retained (not deleted) this PR to keep
the full suite green; a followup deletes them + reconciles their tests, and **moves `isValidOktaClientId` into
`okta-provider-contract.ts`** (currently in `okta-authorize-url.ts`; also drops `okta-disconnect-execute`'s
`OktaTransactionStore` dependency):
`okta-authorize-url` (builder), `okta-oauth-transaction`, `okta-transaction-store`, `okta-pkce-verifier-store`,
`okta-callback-foundation`, `okta-callback-route-handler`, `okta-token-exchange`, `okta-token-exchange-adapter`,
`okta-credential-write`, `okta-connect-gate`.

## Validation
- `tsc --noEmit` clean · `eslint` clean · full v3 vitest suite **1528 passed / 22 skipped / 0 failed**.
- No dangling Okta callback route; no customer-facing browser-OAuth wording (asserted by the wizard safety test).

## Safety
No secret value retrieved; the current secret contents were not independently inspected; no private key printed; no assertion
signed; no token acquired; no Okta API call; no sync; no schedule; no production access. RISK-007 OPEN; Phase C BLOCKED; Okta
`certificationOnly` for execution.
