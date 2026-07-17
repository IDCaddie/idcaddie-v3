# P5E18b — implementation decision record (before coding)

Prepare the **real Okta staging connection path** (hosted-staging metadata + secret-reference wiring), stopping **before** authorization redirect, token exchange, API calls, or any sync. Staging-only; no production. Okta stays `certificationOnly`; RISK-007 OPEN; Phase C BLOCKED.

Baseline (Phase 0, verified): v3 `main` = `9f0ac77` (P5E18a merged; `okta-live/` present), runner `main` = `83089d3`; both clean, no untracked. Branches: v3 `feat/okta-staging-connection-preparation`, runner `feat/okta-staging-credential-wiring`. AWS identity = account **833822972703** (staging), region `ca-central-1`; Supabase linked ref = **ycdpzduxugdsffjqyoai** (staging). Not production.

## Gap reconciliation (P5E18a → real staging path)

| # | Item | P5E18a status | P5E18b decision |
|---|------|---------------|-----------------|
| 1 | Callback route ownership | inert shared `/connectors/oauth/callback` (Slack-wired); okta callback foundation is a pure module | **Implement now**: a provider-selecting okta callback route that stops before exchange (Phase 8) |
| 2 | OAuth transaction persistence | app-layer model only | **Implement now**: real single-use persistence via `oauth_pending` (provider='okta', no migration) + a transient PKCE-verifier store (Phase 4) |
| 3 | PKCE verifier persistence | held server-side, never persisted | **Implement now**: short-TTL, one-time, server-only encrypted/transient verifier store (Phase 4); never browser/URL/cookie/audit |
| 4 | Issuer binding | app-layer only (deferred) | **Implement now**: migration `0048` non-secret RLS table (Phase 3), applied LOCAL; staging apply = Phase 13 |
| 5 | Client ID reference | `OktaClientIdSource` abstraction | **Implement now** as a server-only non-secret config model (Phase 5); **not populated** — deferred until the operator creates the Okta app |
| 6 | Client-authentication method | contract allows private_key_jwt / client_secret | **Decision (Phase 2)**: prefer **private_key_jwt** (the existing runner Okta design already assumes it); documented, not silently switched |
| 7 | Secret-manager interface | pointer read (0043) only | **Implement now**: a write-only credential-write boundary interface (Phase 7); **no real secret body** |
| 8 | Connection-row persistence | model only | **Implement now**: atomic connected-unsynced flow (Phase 9); unreachable while certificationOnly |
| 9 | Credential-reference persistence | read store (0043) exists | reuse 0043; the WRITE path is the Phase 7 boundary |
| 10 | Callback failure rollback | n/a | **Implement now** (Phase 8/9): atomic consume + rollback |
| 11 | Authorization-code redaction | code value never echoed | preserved + tested |
| 12 | Token-exchange timeout/retries | interface only | **Implement now** dormant real adapter (Phase 6): timeout, AbortSignal, no broad retries, size/content-type limits, mocked transport only |
| 13 | Disconnect/revocation | model only | **Implement now** staging-safe disconnect (Phase 10) |
| 14 | Hosted environment gates | governance gate pinned blocked | reuse; add staging-only enforcement |
| 15 | Vercel env needs | — | **Document names only** (Phase 12); no values |
| 16 | Staging Supabase schema needs | — | migration `0048` (Phase 3/13) |
| 17 | Runner credential-consumption | dispatch guard only | **Implement now** dormant consumption boundary (Phase 11) |
| 18 | Audit-event persistence | builders only, unwired | keep unwired; wire only sanitized events at safe points |
| 19 | Customer/admin role requirements | admin roles in connect gate | reuse; issuer-binding read = org admin |

## Classification

- **Implemented now (code, local, dormant):** issuer-binding migration + RLS + tests (0048); OAuth transaction persistence + transient PKCE store; server-only client-config model + bundle guards; dormant real token-exchange adapter (mocked transport); provider-selecting callback route (stops before exchange); connected-unsynced persistence flow; disconnect/revocation; runner credential-consumption boundary; customer-safe UI future states; security/failure tests; docs.
- **Applied to LOCAL only (this phase):** migration 0048 (Phase 3 requires local first).
- **Hosted-staging (checkpointed):** (a) apply 0048 to staging `ycdpzduxugdsffjqyoai` after dry-run/diff review + positive staging confirmation (Phase 13); (b) staging AWS secret-namespace + IAM policy **scaffolding as reviewable IaC/config** (Phase 7/12) — no imperative resource creation without confirmation, no real secret body.
- **Deferred until a real Okta application exists:** a real client ID (via the approved non-secret staging config path), the redirect URI byte-match verification against the created app, trusted-origin config.
- **Blocked by governance:** authorization redirect, token exchange, credential body creation, connection activation, first sync — all fail closed (certificationOnly + Phase C blocked).
- **Blocked by customer authorization:** any real customer connection / PII.
- **Blocked by missing secret material:** the credential body write (Phase 7 keeps the boundary write-only + interface; no secret created).

## Client-authentication method decision (Phase 2)
**private_key_jwt** (RS256 client assertion over `grant_type=authorization_code`), NOT `client_secret`. Rationale: the runner Okta foundation (P5E16 `okta-auth.ts`) is already built around a pre-signed private_key_jwt client assertion; choosing client_secret would silently diverge the two sides and require a shared plaintext secret in the exchange POST. The signer (KMS-backed) stays unbuilt/dormant; the exchange adapter takes an injected assertion. Documented in `docs/runbooks/OKTA_STAGING_APP_SETUP.md`.

## Hosted-mutation checkpoints (require deliberate, dry-run-first execution)
1. **Staging Supabase migration apply (0048)** — schema-only, non-secret, RLS-gated, dormant table (same class as 0043/0044/0047 previously applied to this staging project). Phase 13 mandates dry-run/diff + positive `ycdpzduxugdsffjqyoai` confirmation before apply. No production.
2. **AWS staging secret-namespace + IAM scaffolding** — prepared as reviewable IaC/config in-repo; actual hosted resource creation is a confirmed step. No real secret value. No ECS launch.

Everything else is local, reversible, and testable.
