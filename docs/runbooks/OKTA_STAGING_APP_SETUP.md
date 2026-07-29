# Okta staging application setup — operator checklist (API Services model) — ⛔ GO-GATED

> **CORRECTED MODEL (supersedes all earlier Authorization-Code / PKCE / callback / browser-consent instructions).** Okta uses an
> **OAuth 2.0 API Services application** with the **Client Credentials** grant and **private_key_jwt** client authentication. There is
> **no browser `/authorize` flow, no PKCE, no redirect URI, and no callback**. The durable credential is the **signing key** (in AWS
> Secrets Manager, read only by the runner); short-lived access tokens are minted **inside the runner** on demand and discarded.
> This matches the runner (`okta-auth.ts` builds `grant_type=client_credentials`) and `idcaddie-connector-runner/docs/OKTA_AUTHENTICATION_DESIGN.md`.
>
> **The earlier Web Application (client id `0oa15f4fcshwergKU698`) is the WRONG model and must be REPLACED with an API Services app.**
> Do not create the app / grant scope / assign a role until a separate explicit GO is given AND RISK-007 is closed AND Phase C is
> unblocked for execution. Engineering created NO Okta app, configured NO client id, and created/read NO signing key.

## 0. Why this model
The product is an unattended background connector that periodically reads users, groups and applications with the three read-only
scopes in §6, must run without the connecting admin being logged in, and must not depend on that admin's continued employment. Only **API Services + Client
Credentials + private_key_jwt** satisfies that (service context, no user, no refresh token). The Authorization-Code/Web-App model
would make the durable credential an admin-tied refresh token — which breaks when the admin leaves.

## 1. Where to create it
Okta Admin Console (the staging test org **trial-5294016.okta.com** only) → **Applications → Create App Integration → API Services**.
(NOT "OIDC - Web Application".)

## 2. Grant type
**Client Credentials** (default and only grant for API Services). Do NOT enable Authorization Code, Implicit, Hybrid, Device, or Password.

## 3. Client authentication — **private_key_jwt**
Set client authentication to **Public key / Private key JWT** (a signed JWT client assertion), NOT a client secret.

## 4. Register the public key (reuse the existing keypair only if safe)
Register **ID Caddie's PUBLIC JWK**. If reusing the existing keypair, paste **only the public JWK** — never the private key.
The private key stays in AWS Secrets Manager and is never pasted here or anywhere else.

## 5. Confirm the KID
The registered public key's **KID must equal**:
```
VDkZAQoJl_prLRU83WiPreOBGoP6Fib3qC0CG880wz0
```
(if reusing the existing keypair). If a new keypair is generated, record the new KID and hand it to engineering (non-secret).

> **Corrected in O1B.** This step previously published `i-Wptr…q8j4`, while all 12 connector-runner task definitions already
> expected the value above. Anyone who followed the earlier instruction registered a public key whose private half ID Caddie does
> not hold, and every token request would have failed `invalid_client`. The authoritative value lives in
> `contracts/okta-provider-contract.v1.json` and is asserted by `okta-contract-consistency.test.ts` in both repositories.
>
> **Repository consistency is not proof of registration.** Confirming the KID against the real Okta application is a LIVE
> verification step that remains **outstanding**.

## 6. Grant the scopes — **exactly these three, all read-only**
In the app's **Okta API Scopes** tab, grant **exactly**:

| Scope | Permits |
|---|---|
| `okta.users.read` | Read directory identities and account status |
| `okta.groups.read` | Read group entities and their members |
| `okta.apps.read` | Read application entities and their user/group assignments |

Do NOT grant `okta.logs.read`, `okta.factors.read`, `okta.users.manage`, `okta.groups.manage`, `okta.apps.manage`, or any other
write/admin/lifecycle scope. The set is enforced as an **exact set** — a missing scope and an extra scope both fail closed.

> **Corrected in O1B.** This step previously said *"grant **only** `okta.users.read`. Do NOT grant `okta.groups.read`,
> `okta.apps.read`…"* — the opposite of what the connector-runner requires. Group and application discovery (Phases 5–12) read
> those endpoints, so a customer following the old instruction would have produced `403`s on every group and application read.
> V3's validator additionally listed `okta.apps.read` as **prohibited**, so the correct grant would have been *rejected* at the
> configuration gate.

## 7. Assign a least-privileged admin role — **exact role UNRESOLVED**

API Services apps need an **admin role** to actually reach the API in addition to the granted scopes. This role is assigned to the
**application**, not to a person.

**What is known:** the role must be **read-only** and as narrow as possible. Never assign a role that can make changes, and do not
assign Super Admin — the OAuth scopes above are read-only and a write-capable role would defeat that.

**What is NOT yet established:** the exact role or resource set that covers reading users, groups **and** applications.

> **Unresolved setup requirement (O1B).** This step previously specified a **Read-Only Administrator constrained by a resource set
> scoped to users only**. That cannot be correct now that `okta.groups.read` and `okta.apps.read` are required — a users-only
> resource set would not permit reading applications. Rather than guess a role and send an operator to configure the wrong thing,
> this is recorded as **unresolved**: determine the minimum role empirically against the dedicated Okta test organisation, then
> document the finding here.
>
> Note that OAuth **scopes** and Okta **admin-role** assignment are separate mechanisms. Read-only scopes do not imply any
> particular role, and a role must never be broadened merely because a scope was added.

## 8–11. Do NOT
- **No redirect URI** (API Services apps have none).
- **No Authorization Code.**
- **No PKCE.**
- **No assigned test user** (API Services apps are not user-assigned; the admin role in §7 governs access).

## 12. Record the new client ID
Record the new **API Services client id** (`0oa…`) and return it to engineering — it is **non-secret** and replaces the old Web
App client id `0oa15f4fcshwergKU698`. Never return the private key.

## 13. Never expose the private key
The private key is entered by the operator **directly into AWS Secrets Manager** (secret
`/idcaddie/staging/connector/okta/staging-app-v1`), never into chat, Git, a PR, a screenshot, or a log.

## 14. Update the AWS secret (after the new client id exists)
Once the API Services client id is available, update the secret value to:
```json
{ "okta_domain": "trial-5294016.okta.com", "client_id": "<NEW API Services client id>", "private_key": "<same key if reused>" }
```
(shape matches `idcaddie-connector-runner/src/connector-sync/okta-secret.ts` — no `access_token`, no `refresh_token`, no assertion).
Then re-tag the secret (`State`, `SecretMaterial`) to reflect that real material is present. Confirm via `describe-secret` metadata
only — **never** `get-secret-value`.

## 15. STOP POINT
Creating the app / granting scope / assigning the role and populating the secret are the **only** operator actions. After they are
done and the new client id is supplied, engineering records the issuer binding + credential reference and sets the connection to
`verification_pending` — **no token is minted, no Okta API is called, sync/scheduling stay blocked, RISK-007 stays OPEN, Phase C
stays BLOCKED**. A real client-credentials token mint (`verified`) requires a **separate** later GO.
