# Okta first pilot runbook — ⛔ NOT AUTHORIZED

> **STATUS: NOT AUTHORIZED. Do not execute any step below.** Okta is `certificationOnly`; RISK-007 is OPEN; Phase C is BLOCKED. This runbook documents the FUTURE supervised procedure so it is reviewable now. Every real-execution step is blocked until **all** of the following are true — verified and recorded — AND a separate explicit GO is given:
>
> 1. RISK-007 is closed (at its defined criteria).
> 2. Phase C is explicitly unblocked (governance record).
> 3. Written customer authorization exists for the pilot organization.
> 4. Real Okta credentials are provisioned into the vault (external store) with a credential reference recorded.
> 5. A signed staging first-sync authorization exists (named operator + rollback owner + bounded caps).
> 6. A separate explicit GO for this specific run.
>
> Until then, the connect gate, callback, exchange, dispatch, and first-sync all fail closed by construction (see the threat model + evidence doc). No step here may run in production.

## Preconditions checklist (all must be ✅ before any step)
- [ ] RISK-007 closed · [ ] Phase C unblocked · [ ] customer authorization on file · [ ] real credentials provisioned · [ ] staging first-sync authorization signed · [ ] explicit GO

---

## 1. Prerequisites
Staging environment only. Supabase staging project. Runner staging config. Named operator + named rollback owner. Evidence directory prepared. **Blocked** until the checklist above is ✅.

## 2. Customer authorization evidence
Record: customer legal entity, authorizing contact, scope agreed (read-only user discovery), date, ticket reference. **Blocked.**

## 3. Okta application requirements
Customer creates an Okta OAuth **service app** (authorization-code + PKCE; or private_key_jwt per the auth design). Least privilege. **We do not create the Okta app or its secret** — the customer does, in their tenant. **Blocked.**

## 4. Exact scope
`okta.users.read` **only**. Any other scope (groups/apps/logs/factors/write) is out of scope and must be rejected. Verify no extra scope was granted. **Blocked.**

## 5. Redirect URI verification
The Okta app's redirect URI must byte-match the server-trusted callback (`https://<staging-host>/connectors/oauth/callback`, no trailing slash). Verify verbatim. **Blocked.**

## 6. Issuer verification
Confirm the org issuer (`https://<org>.okta.com` or the allowlisted custom domain) via `validateOktaOrganization`. Record the normalized hostname + issuer. **Blocked.**

## 7. Vault-reference creation
Provision the Okta client credential into the external secret store (out-of-band, least-privilege IAM). Record ONLY the credential **reference** (pointer) + version into `connector_credential_references` via the future server-only provisioning path. **Never** paste a secret/token/code. **Blocked.**

## 8. Connection creation
Create the connector row (provider `okta`) for the customer org; it starts non-`active`/unsynced. Bind the issuer. **Blocked.**

## 9. First-sync authorization
Sign an `OktaFirstSyncAuthorization`: named operator, org, exact connection, approved issuer, exact scope `okta.users.read`, bounded `maxUserCount`, expiry, `maxRuns=1`, rollback owner, evidence ref, `environment=staging`, manual trigger required. **Blocked.**

## 10. Preflight
Dry-run the gates (connect gate, dispatch guard, first-sync) — confirm they PASS only with the signed authorization + unblocked governance, and FAIL closed otherwise. No network. **Blocked.**

## 11. Supervised staging run
Manually trigger ONE bounded run under supervision. No scheduler. Watch the bounded budget (pages/records/retries/runtime). **Blocked.**

## 12. Bounded reconciliation
Reconcile discovered users (review_status pending; no promotion). Verify counts within the cap. **Blocked.**

## 13. Repeat-run idempotency
Re-run once; confirm idempotent (no duplicate facts; run budget enforced). **Blocked.**

## 14. Pause
Pause the connection (updates state only; no schedule exists). **Blocked.**

## 15. Disconnect
Disconnect (invalidate eligibility, pause schedules, invalidate pending transactions, request credential revocation via the sink). **Blocked.**

## 16. Rollback
Rollback owner reverts state + revokes the credential reference. Document. **Blocked.**

## 17. Incident handling
On any anomaly: stop, pause, disconnect, capture evidence, notify. Never widen scope or bypass a gate. **Blocked.**

## 18. Evidence capture
Record correlation ids, gate outcomes, counts — **never** tokens/codes/secrets/PII/full external identifiers. **Blocked.**

## 19. Cleanup
Revoke the credential reference; remove the pilot enrollment; confirm nothing remains runnable. **Blocked.**

## 20. Promotion decision
Separate governance review. Promotion to `enabled` / production is out of scope and requires its own multi-signature GO. **Blocked.**

---

## Future revocation procedure (design)
Disconnect requests revocation through `OktaCredentialRevocationSink.markCredentialReferenceRevoked({connectorId, tenantId, provider})` — which (future) marks the reference revoked/pending-deletion and, separately, calls the Okta token-revocation endpoint via the live edge. In P5E18a no revocation API is called; the sink is unimplemented. Audit history is preserved; the credential reference is never revealed to the client.
