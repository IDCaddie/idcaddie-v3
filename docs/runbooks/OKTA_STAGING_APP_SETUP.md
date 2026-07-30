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

## 4. Point the app at ID Caddie's JWKS URL — do not paste a key
Under **Client Credentials → Public keys**, choose **"Use a URL to fetch keys dynamically"** and set:
```
https://jwks.staging.idcaddie.com/.well-known/idcaddie-okta-jwks.json
```
Do **not** paste a JWK. Fetching by URL means key rotation is a publication step on ID Caddie's side and never requires the
customer to touch this app again. The endpoint serves public key material only; the private half is a non-exportable AWS KMS key
that cannot be read by anyone, including ID Caddie.

## 5. Confirm the KID
The key served at that URL — and the one the app must resolve — is:
```
p7AyvDK0yI95_HdQBxdhBSOTt9mMYPczGL-4USxaMto
```
This is an **RFC 7638 thumbprint** of the published JWK, so it is verifiable from the endpoint itself rather than taken on trust.

> **Corrected in O1B.** This step previously published `i-Wptr…q8j4`, while all 12 connector-runner task definitions already
> expected the value above. Anyone who followed the earlier instruction registered a public key whose private half ID Caddie does
> not hold, and every token request would have failed `invalid_client`. The authoritative value lives in
> `contracts/okta-provider-contract.v1.json` and is asserted by `okta-contract-consistency.test.ts` in both repositories.
>
> **Updated in O2C.2 (2026-07-30).** Steps 4–5 previously told the customer to paste a public JWK whose private half lived in
> AWS Secrets Manager. Both changed: the key is now a non-exportable KMS key, and the app resolves it through the JWKS URL above.
>
> **Repository consistency is still not proof of registration.** Confirming the key against the real Okta application is a LIVE
> verification step, performed once in O2C.2.

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

## 7. Assign the admin role — **`Read Only Administrator`**

**An admin role is REQUIRED in addition to the scopes.** Okta does not assign one to a service app automatically, so without it every
API call returns **403** even when all three scopes are granted. The role is assigned to the **application**, not to a person.

Assign **`Read Only Administrator`**. It is the minimum *standard* role that covers users, groups, applications and their
assignments, and it cannot change anything in the org.

**Do NOT assign Super Admin.** No official Okta documentation requires it for this integration.

### Scopes and admin role are two different mechanisms

| | Says | Fails when wrong |
|---|---|---|
| **OAuth scopes** (§6) | which Okta APIs ID Caddie may call | at **token request** — the token is refused (`invalid_scope`) |
| **Admin role** (this step) | which data those APIs return | at the **API call** — `403 Forbidden` |

Granting the scopes without the role, or the role without the scopes, does not work. This is the single most common setup mistake,
and the two failure modes above are how to tell which step was missed.

### Why not a custom admin role with a resource set?

A custom role would be narrower, and it is the preferred product position **in principle**. It is **not recommended in v1** because
Okta exposes no read-only permission for application **user** assignments — the available permission is *"Edit app's user
assignments"*, a **write** permission ID Caddie must never request. A least-privilege custom role may therefore return 403 on
`/apps/{id}/users`.

**Status: UNVERIFIED.** Whether a custom role can cover all six read surfaces must be confirmed against the dedicated Okta test
organisation before it is recommended. Until then `Read Only Administrator` is the documented requirement.

**Known trade-off, stated plainly:** `Read Only Administrator` has **no optional resource targets**, so it cannot be narrowed to a
subset of the org — it grants org-wide *read*. That is a real least-privilege compromise, accepted because the alternative is either
a write permission or an unverified configuration.

### Sources

- [Implement OAuth for Okta with a service app](https://developer.okta.com/docs/guides/implement-oauth-for-okta-serviceapp/main/) — an admin role must be assigned; roles are not automatic for apps
- [How to Assign the Correct Admin Role to a Service Application](https://support.okta.com/help/s/article/how-to-assign-the-correct-admin-role-to-a-service-application?language=en_US) — *"An Admin Role must be assigned to the application"*; 403 when absent
- [Roles in Okta](https://developer.okta.com/docs/api/openapi/okta-management/guides/roles) — standard role identifiers; `READ_ONLY_ADMIN` has no optional targets
- [Read-only administrators](https://help.okta.com/en-us/content/topics/security/administrators-read-only-admin.htm) — views users, groups, apps and app instances
- [Role permissions](https://help.okta.com/en-us/content/topics/security/custom-admin-role/about-role-permissions.htm) — custom-role read permissions; no standalone app-assignment read

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
