# P5E18a — Okta live-connection foundation (evidence, DORMANT)

**Status: the production-grade Okta live-connection FOUNDATION is built, typed, and tested — and entirely DORMANT.** Date 2026-07-17. **No real Okta OAuth app, no client secret, no authorization code exchanged, no token acquired, no Okta API call, no credential reference created, no connector execution, no ECS task, no schedule, no hosted migration, no production access — none.** Okta and Microsoft Entra remain `certificationOnly`; **RISK-007 OPEN; Phase C BLOCKED.** The existing simulated preview walkthrough is unchanged and still works.

## Source SHAs
- v3 parent `main` = `a61a035f8186cc39be78c2ed0b2100005e07b701`; branch `feat/okta-live-connection-foundation`.
- runner parent `main` = `0a93cb465ad27ecf62cf5b80233c97c8a238864a`; branch `feat/okta-certification-foundation`.

## Baseline verified (Phase 0)
Both mains fetched + matched the canonical SHAs; clean worktrees; v3 **1404** + runner **817** tests green before changes; Okta `enabled:false`/`status:"future"` (`isConnectorProviderReady("okta")===false`) and NOT in the runner framework-registry (`provider_not_registered`); no live Okta OAuth route/callback/exchange; RISK-007 OPEN; Phase C BLOCKED. (Note: `docs/00_PRODUCT_STATUS.md` carries a caveated line about a general-connector RISK-007/Phase-C track; per the GO and the risk register, this work treats RISK-007 as OPEN and Phase C as BLOCKED and fails closed on both.)

## Files changed
**v3** (all new unless noted):
- `src/lib/server/connector-vault/okta-live/` — `okta-provider-contract.ts` (Phase 2: capabilities, exact scope, prohibited scopes, lifecycle), `okta-org-validator.ts` (Phase 3: SSRF-safe issuer/org validator), `okta-oauth-transaction.ts` (Phase 4: transaction + PKCE), `okta-governance-gate.ts` (phase/RISK gate), `okta-connect-gate.ts` (Phase 5: multi-gate connect), `okta-authorize-url.ts` (Phase 6), `okta-callback-foundation.ts` (Phase 7), `okta-token-exchange.ts` (Phase 8: interface only), `okta-connection-state.ts` (Phase 10), `okta-first-sync-authorization.ts` (Phase 11), `okta-audit-events.ts` (Phase 13), `okta-disconnect.ts` (Phase 15) + colocated tests.
- `src/lib/customer-connectors/okta-connection-labels.ts` (+test) — Phase 14 client-safe future-state labels.
- `src/lib/server/connector-vault/no-client-import.test.ts` (M) — added the `okta-live/` prefix to the client-import guard.
- `docs/security/OKTA_CONNECTOR_THREAT_MODEL.md` (Phase 16), `docs/runbooks/OKTA_FIRST_PILOT_RUNBOOK.md` (Phase 17), this evidence doc, changelog entry.

**runner**: `src/connector-sync/okta-provider-scaffold.ts` (+test) — Phase 12 dormant scaffold (describe + dispatch guard + no-PII logging), reusing the P5E16 okta-* modules. **Framework-registry untouched** (okta stays `provider_not_registered`).

## Architecture (what a future authorized flow becomes)
`select Okta → validate org (server) → connect gate → mint transaction (state+PKCE) → redirect → callback validates (state/PKCE/issuer/tenant/single-use) → stop-before-exchange (certificationOnly) → [future] exchange → store credential REFERENCE only → connection connected-but-unsynced → [future] signed supervised first sync`. Every arrow past "connect gate" is fail-closed today.

## Migrations
**None.** The one genuine schema gap (a per-org issuer-binding table) is **deferred to the credential-provisioning phase** (alongside the deferred 0043 write path) because P5E18a persists **no** rows; the issuer binding is modeled at the app layer. Reuses existing schema unchanged: `connectors` (0017), `connector_credential_references` (0043), control plane (0044), schedule policy (0046), pilot (0047), `oauth_pending` (0020) — all provider-neutral. No hosted migration applied.

## Gates (fail-closed, independent)
- **Provider lifecycle** `certificationOnly` (contract) → no pilot connection, no execution.
- **Governance** `phaseCUnblocked=false ∧ risk007Closed=false ∧ hostedOAuthEnabled=false` → hosted Okta denied.
- **Connect gate**: authenticated · membership · admin role · provider==okta · lifecycle · org flag · environment · governance · valid org · exact scope · fixed callback · safe return route — each independently tested.
- **Callback**: 13 ordered gates; stops before exchange; separate reason codes.
- **Execution eligibility**: 10 independent gates; no reachable state is runnable.
- **First-sync**: absent by default; denied unless signed + enabled + governance-permitting; staging + manual only.
- **Runner dispatch**: `certificationOnly` first; then schedule/auth/phase/credential/first-sync/scope/limit/production — each independent; `provider_not_registered` in the live registry.

## Tests + totals
- **v3**: `okta-live/` **~103** new tests (org validator table 50, transaction/PKCE, connect gate, authorize URL, callback, dormancy, credential boundary) + labels; full v3 suite **1404 → green with the new tests added**.
- **runner**: `okta-provider-scaffold.test.ts` **18** new; full runner suite **836 green** (was 817; Entra regressions intact).

## Dormancy / safety proofs
- **No network call**: no `fetch`/http/aws/pg in any okta-live or okta scaffold module (comment-stripped source scan test in the runner; v3 modules import only `node:crypto` + sibling pure modules).
- **No credential**: credential-reference boundary test — DTO/record/SQL carry only a pointer + version; no token/secret/code/verifier field; `connector_secrets` untouched; no reference row created.
- **No exchange**: `createDormantOktaTokenExchange().exchange` throws; success type exposes only a branded `VaultBoundAccessTokenRef`.
- **No runner dispatch**: `resolveFrameworkProvider("okta")` → `provider_not_registered`; dispatch guard → `provider_certification_only`; certificationOnly + manifest-absence are two independent blocks.
- **No schedule**: first-sync scheduling off; dispatch `schedule_invocation_forbidden`; schedule policy 0046 unchanged (enabled=false).
- **No production access**: governance `hostedOAuthEnabled=false`; first-sync `environment=staging`; dispatch `production_not_authorized`; no hosted target touched.
- **Client boundary**: `no-client-import.test.ts` asserts no `use client`/`src/app` file imports `okta-live/`.

## Remaining blockers (before any real run)
RISK-007 closure; Phase C unblock; customer authorization; real credential provisioning + reference; signed staging first-sync authorization; issuer-binding persistence table (provisioning phase); KMS-backed private_key_jwt signing; the live token-exchange + vault-write edge; a provider-selecting callback route; a separate explicit GO. See the runbook (NOT AUTHORIZED).

## Next authorized phase
Credential-provisioning + first supervised staging run — **only** after the blockers above and a separate GO.
