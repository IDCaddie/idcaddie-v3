# Okta Workforce Identity connector model (P5E16)

**Canonical source for: the certification-only Okta Workforce Identity connector FOUNDATION** (contracts + fixtures +
certification, all inert). The runnable code + tests live in `idcaddie-connector-runner` (`src/connector-sync/okta-*.ts`); the
auth design + certification plan are in that repo's `docs/OKTA_AUTHENTICATION_DESIGN.md` + `OKTA_CERTIFICATION_PLAN.md`. Companion:
[credential & consent model](./OKTA_CREDENTIAL_AND_CONSENT_MODEL.md). **Synthetic-staging + certification only.** Okta is
`certificationOnly`, disabled, NOT customer-selectable, NOT runnable. `microsoft_entra` unchanged; RISK-007 OPEN; Phase C BLOCKED.
**No real Okta tenant, token, key, OAuth token, API call, ECS, schedule, promotion, or production — none this phase.**

## Objective

A provider-neutral, fail-closed Okta connector foundation that can EVENTUALLY (under separate authorization) connect one Okta org
and discover users (then, separately designed + authorized, groups/membership + app-assignments). This phase ships only the inert
contracts + synthetic certification. It **does not** connect, authenticate, call Okta, or become runnable.

## Reuse matrix (do not copy Entra blindly)

| Category | Items |
|---|---|
| **Reused unchanged (provider-neutral)** | `secret-provider`, `http-safety` (SSRF/exact-host guard), `live-http-client`, `provider-http-client`, `discovery-facts` (`AppUserAccountFact` — already cites Okta), `db-writer`/`fact-sink`, `framework-contracts` |
| **Reused pattern (Okta twin)** | strict `rejectDangerousKeys` item/response schemas, the process-memory token cache (provider-pinned), the server-derived reference builder + ownership resolver, the strict token-response parser |
| **Okta-specific (new)** | `okta-user-schemas`, `okta-normalizer`, `okta-auth`, `okta-token-schema`, `okta-token-cache`, `okta-secret`, `okta-connection`, `okta-pagination`, `okta-fixtures`, `okta-certification`, `okta-manifest` + `manifests/okta.v1.json` |
| **Explicitly out of scope** | any runnable `okta-live` / entrypoint / composition-root / pilot / scheduled file — **none created** |

## Okta-specific differences from Microsoft Entra (documented, not copied)

1. **Auth** — OAuth 2.0 client-credentials with a **private_key_jwt** client assertion (a signed JWT), NOT a client_secret. The
   legacy **API token (SSWS)** is modeled as a secondary credential TYPE, not the preferred path. See the auth design doc.
2. **Ids** — Okta ids are OPAQUE (`00u…`), NOT UUIDs; the client id is opaque; only the runner-side org/connection ids are UUIDs.
3. **Host** — a real Okta org host is PER-TENANT (`<org>.okta.com` / a custom domain), SERVER-DERIVED from the ownership-validated
   connection at run time — never a manifest constant. The certification host is the reserved non-routable `okta.certification.invalid`.
4. **Response** — `/api/v1/users` returns a BARE top-level JSON array (not a `{ value: [] }` envelope); `okta_users_page` is an
   array schema.
5. **Pagination** — the next-page cursor is in the RFC 5988 **`Link` HTTP header** (`rel="next"`, `after=<cursor>`), NOT the body.
   `okta-pagination.ts` is the real transport engine; it REUSES the neutral `http-safety` exact-host guard for cross-host rejection.
6. **Status** — Okta `status` is a string lifecycle enum (ACTIVE/SUSPENDED/DEPROVISIONED/STAGED/…), mapped to a canonical
   cross-provider status (`active`/`suspended`/`disabled`/`staged`/`unknown` — never invented).
7. **Manifest** — because of (3)–(5) + the need for auth-mode / retry-budget / discovery-only / promotion-disabled fields the
   vendored framework `ProviderManifestSchema` can't express, Okta uses an **Okta-specific strict manifest** (`okta-manifest.ts`),
   and is deliberately **NOT registered in the runner framework-registry** — so `resolveFrameworkProvider("okta")` fails closed
   (`provider_not_registered`), a stronger dormancy posture than a `certificationOnly` registry entry.

## Minimum certified scope (v1)

**Users only.** Read `/api/v1/users`: stable Okta id, lifecycle status, and an EXPLICITLY approved profile projection (login,
email, first/last/display name). **No** writes, lifecycle mutations, password ops, factor/MFA data, system logs, group data, or app
assignments. Groups + group-membership + app-assignments + factors + logs are **deferred** — each a separately-designed,
separately-authorized capability. Scope: `okta.users.read` only. **[SUPERSEDED O1B — the authoritative set is the three read scopes `okta.users.read`, `okta.groups.read`, `okta.apps.read`; see `contracts/okta-provider-contract.v1.json`.]**

## Discovery + isolation (all inert this phase)

- **Normalization** → the neutral `app_user_account` fact (discovery-only, `review_status=pending`, dedup by
  `signal_id=okta:users:<id>`); unexpected profile fields excluded; NO credentials/factor/MFA/raw payload; NO people/app_users/
  canonical write; NO promotion.
- **Pagination** → deterministic: repeated cursor rejected, missing cursor terminates, cross-host next-link rejected (http-safety),
  page cap 5, record cap 100 (never over-collects), Retry-After bounded (≤60s) + retry cap 2, partial/ambiguous emits nothing.
- **Isolation** → the secret ARN is pinned to `/idcaddie/staging/connector/okta/…`; the credential reference + org host are
  SERVER-DERIVED from an ownership-validated connection (wrong tenant/connector/provider/version/status all fail closed); the token
  cache key is a validated `(org, connection, provider="okta", version)` tuple (no cross-tenant or cross-provider bleed); the
  credential-document parser returns METADATA only (never the private key / API token).

## Dormancy

Okta is `certificationOnly`, disabled/future in the vendored provider-registry, NOT in the runner framework-registry, has NO
manifest in the vendored (live) manifests dir, NO live-composition/entrypoint/pilot/scheduled file, is activatable by NO env
var/HTTP input/UI, references NO real Okta host or production identifier, and is proven inert by `okta-certification.test.ts`.
Enabling Okta (a live org, a real credential, a first run) is a separate, explicit future GO. No DB migration was needed
(`connectors.provider` + the control-plane tables are provider-neutral).
