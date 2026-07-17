# Okta staging application setup — operator checklist (P5E18b) — ⛔ NOT AUTHORIZED YET

> **STATUS: NOT AUTHORIZED.** Do not create the Okta application until a separate explicit GO is given AND RISK-007 is closed AND Phase C is unblocked. This is the exact operator checklist + engineering handoff for a FUTURE staging pilot. Engineering created NO Okta app, configured NO client id, and created/read NO client secret in P5E18b.

## 1. Where to create it
The customer's (or the staging test) Okta org admin console → **Applications → Create App Integration**. Staging org only.

## 2. Application type
**Web Application** (server-side; confidential client).

## 3. Grant type
**Authorization Code** only. Enable **PKCE** (S256). Do NOT enable Implicit, Hybrid, Client Credentials, Device, or Resource Owner Password.

## 4. Exact staging redirect URI (byte-match, no wildcard, no localhost)
```
https://idcaddie-v3.vercel.app/connectors/oauth/okta/callback
```
- This is the dedicated, provider-isolated Okta callback path (NOT the shared Slack callback). It must byte-match the server-trusted value (`CONNECTOR_OKTA_REDIRECT_URI`, default above). No trailing slash. If the deployed staging host differs, use that host with the same path and update `CONNECTOR_OKTA_REDIRECT_URI` to match.
- Add **no** alternate/unapproved redirect. No `localhost`.

## 5. Exact requested scope
**`okta.users.read`** only. Do NOT grant `okta.groups.read`, `okta.apps.read`, `okta.logs.read`, `okta.factors.read`, or any write/admin/lifecycle scope.

## 6. Client-authentication method — **private_key_jwt**
Configure the app for **private_key_jwt** (a signed JWT client assertion), NOT a shared client secret. Rationale: the runner Okta design + the v3 token-exchange adapter are built around a private_key_jwt assertion. Register the app's public key (JWK); the private signing key is KMS-backed and provisioned separately (do NOT paste a private key anywhere). If your org cannot support private_key_jwt, STOP and escalate — do not silently switch to `client_secret`.

## 7. Assignments
Assign **only** an authorized staging administrator or a dedicated test identity. Do NOT use the "Everyone" / broad assignment unless separately approved.

## 8. Trusted origins
Add only those strictly required for the flow. Do NOT add broad CORS origins or extra redirect origins.

## 9. Non-secret metadata the operator may return to engineering
Only these (all NON-secret) — via the approved staging config path (`CONNECTOR_OKTA_*` env NAMES), never in chat/Git/screenshots:
- the **client id** (`0oa…`) — public;
- the org **issuer** (`https://<org>.okta.com`);
- the granted **scope** (`okta.users.read`);
- the redirect URI as registered (for byte-match confirmation).

## 10. How the secret material must be entered (never exposed)
The private signing key / any secret material is entered **directly into AWS Secrets Manager** under `/idcaddie/staging/connector/okta/<segment>` (staging account 833822972703, ca-central-1) by the operator — **never** pasted into chat, Git, a PR, a screenshot, shell history, or a log. See `idcaddie-connector-runner/deploy/OKTA_STAGING_IAM.md` for the least-privilege read-grant spec.

## 11. How to confirm creation without revealing the secret
- Confirm the secret EXISTS by name/ARN metadata only (`aws secretsmanager describe-secret` — metadata, never `get-secret-value`).
- Confirm the app exists + the redirect/scope/auth-method via the Okta console (screenshots must exclude any secret).
- Record creation timestamp + version/stage metadata + IAM attachment metadata only.

## 12. STOP POINT
**Stop here.** Do NOT click the real "Authorize"/connect button, do NOT initiate an OAuth redirect, and do NOT let any real authorization code or token be produced. The engineering side stays certificationOnly + Phase C blocked; the real connect path fails closed. Resuming requires a separate explicit GO (see `OKTA_FIRST_PILOT_RUNBOOK.md`).
