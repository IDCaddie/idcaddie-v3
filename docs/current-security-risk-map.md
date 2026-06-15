# Current Security Risk Map (Legacy Firebase ID Caddie)

Source: `/Users/samvemuri/Desktop/IDCaddie_Repo-main`. Every claim cites exact legacy file:line.
This map drives [v3-security-model.md](./v3-security-model.md). Companion: [current-product-map.md](./current-product-map.md).

## Trust boundaries
1. **Browser ↔ Firestore (direct client SDK).** The primary boundary. ~198 direct `.firestore()` call sites in `frontend-v2/src` (54 files); ~188 are client mutations (`.add/.update/.delete/.set/.batch`). Authorization for these lives in `webapp/firestore.rules` — **plus client-side filtering that is NOT a security boundary** (`frontend-v2/src/context/DataProvider.js:47-62`).
2. **Browser ↔ Cloud Functions (`httpsCallable`).** ~30 privileged callables. Enforcement = per-function `context.auth`/role checks — inconsistent, several missing (below).
3. **External ↔ HTTP endpoints.** SCIM (`scim/index.js`), inbound API/email (`api/v1/ingest/*`), Chrome plugin (`api/chromePluginFunction.js`), `get_apps` — token/API-key gated.
4. **Functions (Admin SDK) ↔ Firestore/Storage.** Full-trust service-account context; `allow ... if false` rules delegate sensitive collections here.
5. **Tenant ↔ tenant.** Enforced only by **separate Firebase projects** (`webapp/.firebaserc`). No in-DB tenant scoping — a regression risk if ported to a shared Supabase DB.

## Authorization model (as built)
Two parallel role planes, copied across three stores that must stay in sync:
- **Site role** custom claim `token.role` ∈ `{admin, editor, viewer, user}` (`webapp/functions/src/auth/roleChecks.js:7-12`).
- **Group role** `token.groups{ groupId: manager|viewer }` (`groups/groupManagement.js:183,282`), canonical membership in `groups/{gid}/members/{uid}`.
- Resources carry a plain `groups: []` array; rules check overlap (`firestore.rules:380-385`).
- Stored in: auth claim + `users/{uid}` doc + membership doc — updated by separate non-transactional writes (`userCRUD.js`, `groupManagement.js`, `onUserCreate.js`).
- **No org/agency tier exists** (`grep` for omnicom/flywheel/org_manager/agency in auth code = none). `org_manager`/`org_viewer` are **net-new** for v3.

## Direct Firestore access from frontend (the anti-pattern v3 removes)
Hottest client-write collections: `IDCApps` (74), `files` (31), `users` (25), `contracts` (20), `invoices` (17), `licenses` (12), `people` (9). Live `onSnapshot` subscriptions in `DataProvider.js`, `PeopleMetricsContext.tsx`. No `/api` route layer (`grep fetch('/api'` = none). → Replace wholesale with Postgres tables + RLS + server actions.

## Functions callable by authenticated (or unauthenticated) users
| Function | File | Issue |
|---|---|---|
| `sendVerificationEmail` | `auth/emailVerification.js` | **No auth** — mails arbitrary addresses (enumeration/mail-bomb) |
| `sendUserInviteEmail` | `email/sendInviteEmail.js` | **No auth** — attacker-supplied invite link/role (phishing) |
| `syncAppApps` | `appScraping/syncAppApps.js:34-59` | **No auth** — reads `private/scraperCredentials`, drives provider calls for any app id |
| `calculateFieldValues` | `companies/IDCApps/calculateFieldValues/calculateFieldValues.js` | **No auth** — 540s/2GB batch write (DoS + integrity) |
| `retryProcessUserlistFile` | `files/onFileLinkedToApp.js` | auth, **no role** — reprocesses any file, overwrites an app's users |
| `rebuildPeople` | `companies/people/rebuildPeopleCollection.js` | auth, no role — full people rebuild |
| `manualCalculateMonthlyBilling` | `companies/billing/calculateMonthlyBilling.js` | auth, no role — recomputes billing |
| `getCompanyEmails` | `api/chromePluginFunction.js` | any authenticated user (incl. lowest role) dumps all company emails |
| `sendUserInviteEmailHttp` | `email/sendInviteEmail.js` | HTTP + env token, CORS `*` |

## Credential / token handling
- **Integration secrets stored PLAINTEXT** at `IDCApps/{appId}/private/scraperCredentials` (`scraperConfigManager.js:122-128,284-289`; schema `scraperConfigSchema.js:282-407`) — AWS secret keys, Google service-account private keys, OAuth/basic-auth secrets. No KMS/encryption (grep = none). Gated from browser by `firestore.rules:268-270` (`if false`), but readable by any function/admin/backup actor.
- **Tokens — mixed:** API keys (`createAPIKeyFunction.js:36-44`) and SCIM tokens (`scim/scimTokenManager.js:23-34`) are SHA-256 hashed, show-once (good). **Ingestor tokens** (`generateIngestorToken.js:54-58`) and **inbound-email tokens** (`generateInboundEmailToken.js:20-30`) are **plaintext / id-as-secret**, compared non-constant-time (`handleIngestData.js:42`). Auto-created scraper ingestor token uses `Math.random()` with `validUntil:null` (never expires) (`automatedScrapingService.js:501-505`).
- **SCIM revoke** doesn't clear the 5-min token cache (`scimTokenManager.js:42-54` vs `:120-123`); env-var fallback compared with `===` (`scim/index.js:28-49`).

## Role / group / permission logic
- **Group-manager edit is not group-specific** (`firestore.rules:388-409`): grants edit if user is `manager` in *any* group AND member of *any* of the resource's groups — not the same group. Comment admits it and defers to frontend. The weaker disjunct coexists via `OR` with `hasManagerPermission` (`:80`).
- **Token-refresh staleness:** permission changes don't apply until token refresh (~1h); `revokeRefreshTokens` doesn't force client refresh (`GROUP_PERMISSIONS_TOKEN_REFRESH_ISSUE.md`).
- **Permission subcollections** (`permissionSync.js`) denormalize access with overlapping triggers and inconsistent removal logic → drift. Unnecessary under RLS.
- **Transitive grants:** assigning a contract to a group silently grants its linked apps (`linkedResourceSync.js:51-195`).
- **Over-broad `list`:** any authenticated user can `list` `IDCApps`/`invoices`/`contracts`/`groups` (`firestore.rules:75,150,176,295`) — `list` skips per-doc rules. Any auth user can read **every** user profile (`firestore.rules:12`).

## Data deletion / export / import paths
- **Destructive import:** CSV/API ingest does full-replace and **hard-deletes** users whose `lastUpdated` ≠ this run (`files/onFileLinkedToApp.js:283-290`), with **no schema/email validation** (`handleIngestData.js:33-57`) and no audit of removals.
- **App-delete cascade** hard-deletes ALL subcollections incl. `scraperLogs` and audited data, **no record** (`watchAppDeleted.js:20-29`). No transactions/rollback.
- **File-doc delete** doesn't cascade to derived `invoices`/app users/licenses → orphans (`onDeleteFirestoreFileDoc.js`); orphan-cleanup scheduler is disabled (`cleanupOrphanedLinks.js:110`).
- **Export:** scheduled/manual email reports send company-wide financials + owner emails as unencrypted HTML via Postmark (`email/*`); custom report builder exports arbitrary admin-selected fields (`reportScheduleRunner.js:214-234`).

## Auditability
- Central writer `logging/logChange.js:30-32` → top-level `logs` collection. `logs` is `read: isAdmin`, `write: if false` for clients (`firestore.rules:201-204`) — append-only **by convention only**.
- **Violations:** (a) `IDCApps/{appId}/scraperLogs/{logId}` is **editor-writable AND deletable** (`firestore.rules:110-113`) — forgeable per-app log; (b) functions/Admin SDK can rewrite/delete any `logs` row; (c) `cleanupOldLogs.js:13-36` **hard-purges** logs > 90 days.
- **Weak actor attribution:** most automated/import writes attributed to `'system'`, not a real user (`appOnWriteLog.js:24-25`, `fileOnWrite.js:24-25`).

## Storage
- Single bucket, **not tenant-scoped** (`webapp/storage.rules`). `canAccessFile()` grants any admin/editor/viewer read to **ALL** files regardless of group (`:13-15`); any editor write to all files (`:25-27`). Paths: `files/{id}`, `AI_files/{id}/`, `temp/{uid}/`, `system/` (deny).

---

## Ranked risk register

### P0 — critical
1. **Plaintext integration secrets at rest** — `scraperConfigManager.js:122-128`. Any function/console/backup leak exposes every connected customer system. *(DEFER connectors, but v3 credential store must be encrypted + service-role-only.)*
2. **Audit logs not truly immutable** — editor-writable `scraperLogs` (`firestore.rules:110-113`); Admin-SDK delete; 90-day hard purge (`cleanupOldLogs.js`). v3 `audit_logs` must be DB-enforced INSERT-only + retained.
3. **Destructive imports, no validation, no audit** — `onFileLinkedToApp.js:283-290` + `handleIngestData.js:33-57`.
4. **App-delete cascade wipes audited data silently** — `watchAppDeleted.js:20-29`.
5. **Group-manager privilege escalation** — `firestore.rules:388-409` (cross-group edit). Fix via exact `(resource_group, user, role)` RLS join.
6. **Authorization depends on frontend filtering** — `DataProvider.js:47-62` + open `list` rules. RLS must fully scope `SELECT`.
7. **Inbound-email ingest has no webhook auth** — `processInboundEmail.js:8-36`; id-as-secret token, no signature, attachments stored unscanned.

### P1 — high
8. Unauth'd / under-authorized callables (`sendVerificationEmail`, `syncAppApps`, `calculateFieldValues`, `sendUserInviteEmail`, `retryProcessUserlistFile`, `getCompanyEmails`).
9. Any auth user reads **every** user profile (`firestore.rules:12`) + over-broad `list` (`:75,150,176,295`).
10. Ingestor/inbound tokens plaintext + non-constant-time compare; never-expiring scraper token (`Math.random`).
11. Three-way role sync, non-transactional, swallowed failures → claim/doc divergence.
12. Token-refresh staleness (~1h) for permission changes.
13. Unscoped storage; viewer reads all files, editor writes all files (`storage.rules:13-15,25-27`).
14. Weak audit actor attribution (`'system'`).

### P2 — medium
15. Permission-subcollection sync drift (`permissionSync.js`).
16. Transitive group grants via linked resources (`linkedResourceSync.js`).
17. Inconsistent create/delete authority (docs say delete=admin, rules grant delete=editor).
18. Unencrypted PII/financials in emailed reports; arbitrary-field custom export.
19. SCIM env-var plaintext fallback; revoke doesn't clear cache.
20. 90-day audit retention loses history (hard delete).
21. No in-DB tenant scoping (project-per-tenant only).

### P3 — low
22. `apiHelperFunctions.js:10-14` weak `Math.random` key generator (dead helper).
23. onCreate race between `onUserCreate.js` and `createUserDocument` (3s-sleep mitigation).
24. Service-account key prefix/length logged (`googleScraper.js`).
25. Legacy multi-tenant report code lingering (`scheduledJobs/generateReportRuns.js`) — dead-path confusion.
26. CORS allows `localhost:3000` against prod storage origins (`webapp/cors.*.json`).
