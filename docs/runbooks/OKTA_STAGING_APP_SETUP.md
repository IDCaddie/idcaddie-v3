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
The product is an unattended background connector that periodically reads users with `okta.users.read`, must run without the
connecting admin being logged in, and must not depend on that admin's continued employment. Only **API Services + Client
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
i-Wptr6usN1tpkNp17vHXv_Mar4NPz53rn-bmlTq8j4
```
(if reusing the existing keypair). If a new keypair is generated, record the new KID and hand it to engineering (non-secret).

## 6. Grant the scope — **`okta.users.read` only**
In the app's **Okta API Scopes** tab, grant **only** `okta.users.read`. Do NOT grant `okta.groups.read`, `okta.apps.read`,
`okta.logs.read`, `okta.users.manage`, or any write/admin/lifecycle scope.

## 7. Assign a least-privileged admin role
API Services apps need an **admin role** to actually reach the Users API. Assign the **least-privileged** applicable role — a
**Read-Only Administrator**, ideally **constrained by a resource set** scoped to users only (a custom admin role + resource set is
preferred over the broad built-in). This role is assigned to the **application**, not to a person.

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
