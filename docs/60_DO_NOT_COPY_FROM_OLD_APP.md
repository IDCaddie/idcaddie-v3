# 14 — Do Not Copy From the Old App

> **CURRENT CURSOR (updated 2026-07-08):** `idcaddie-v3` main @ `7f7d050`, PRs merged **through #284**.
> `idcaddie-connector-runner` main @ `84ecf6d`. **The `768f91a` / "through #264" figure below is this page's original
> 2026-07-07 snapshot — historical, not current.** The do-not-copy guidance itself is timeless and still applies.
> Governance (current, 2026-07-10): RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as a governance state only (C-2c staging live sync completed 2026-07-10 (staging-only; production untouched; connector-runner PR #36)); production untouched; connector live data-sync
> has not run (earlier hosted staging RISK-007 proof steps occurred under gated procedures, but those were not Phase C
> live data-sync).

**A safety guide for engineers, product, security reviewers, and AI coding agents.**
Rebuild pack doc 14 of 7. Companions: `55_REBUILD_STATUS.md` (where we are now),
`56_OLD_APP_PARITY_REGISTER.md` (old-app feature parity), `57_CONNECTOR_PARITY_REGISTER.md`
(connectors), `58_AI_FEATURE_PARITY_REGISTER.md` (AI features),
`59_WORKSTREAM_ROADMAP.md` (what we build next and in what order), and
`61_NEXT_3_DAYS_PLAN.md` (the immediate plan).

Last reviewed: **2026-07-07**. Repo: `idcaddie-v3` `main @ 768f91a` (PRs through #264 merged).

---

## Why this document exists

The old ("legacy") ID Caddie was a Firebase/Firestore application. It works, and it is a
useful **record of what the product does** — but many of the ways it was *built* are unsafe,
and several were the direct cause of real security risks. This rebuild (v3) exists partly to
replace those patterns.

The danger during a rebuild is subtle: when you copy a *feature* from the old app, it is very
easy to also copy the old *mechanism* — the exact code shape that made it work — and that
mechanism is often the thing we are trying to eliminate. This document is the list of
mechanisms you must **not** carry over, each paired with the safe v3 way to get the same
outcome.

**Who must read this:** anyone (human or AI agent) about to (a) port a legacy feature,
(b) look at legacy source for "how they did it," or (c) write any code that reads or writes
tenant data, handles a secret/token, or exposes data to a browser.

### How to read the FACT / INFERENCE tags

- **[FACT]** = directly evidenced. Legacy claims cite the exact legacy `file:line` recorded in
  `docs/current-security-risk-map.md` (a read-only audit of the legacy repo). v3 claims cite a
  v3 doc, migration, or source file in this repo.
- **[INFERENCE]** = a reasoned generalization, recommendation, or "this is the safe way"
  judgement. Reasonable, but not a copied-out fact — challenge it if you have better evidence.

### The one rule that overrides everything else

**Never read or print the contents of a secret.** Do not open, cat, echo, log, or paste the
body of any `*.key`, `*.pem`, `*.env`, service-account JSON, token, or credential — not into
code, not into a doc, not into a chat, not into a commit. If you *find* such a file, that is a
**finding to report** (see §1), not a file to open. This rule is absolute and applies to
humans and agents equally.

> **Governance note (do not weaken):** Real connector-secret handling is gated by **RISK-007**,
> which is **OPEN**. "Phase C" (the live-connector-execution phase) is **BLOCKED**. No live
> connector sync has run. Nothing in this document authorizes handling a real customer secret,
> running a live sync, or touching production. See `04_RISK_REGISTER.md` and
> `52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`.

---

## Quick reference — the 11 patterns to never copy

| # | Legacy pattern (do NOT copy) | v3 safe replacement |
|---|---|---|
| 1 | Private keys / secrets committed or stored in the repo or in readable app storage | KMS-backed vault; secrets never in git, never in a readable row |
| 2 | Admin/service-role SDK in the request path with ad-hoc per-handler role checks | User-scoped client + RLS as the single authorization boundary; no service role on request paths |
| 3 | Client-side (browser) filtering as the security boundary | RLS scopes every `SELECT` in the database; the browser is untrusted |
| 4 | Blanket "any logged-in user can list the whole collection" reads | Per-row RLS `SELECT` policies; default-deny tables until a reviewed policy exists |
| 5 | Raw JSON / whole-document dumps to the client | Explicit safe-column DTOs; select only what the UI needs |
| 6 | Connector/integration secrets exposed to functions, logs, errors, or exports | Envelope-encrypted vault; runner-only decrypt; redacted logs/errors; metadata-only DTOs |
| 7 | Browser-minted "show-once" API / SCIM / ingestion tokens, some plaintext/never-expiring | Server-issued, hashed-at-rest, constant-time compare, expiring, revocable tokens |
| 8 | Unauthenticated token-in-URL public report views that bypass authorization | Scoped, expiring, tenant-bound tokens over a safe read projection, audited — or don't build it |
| 9 | Role/permission read from a user-writable profile field | Roles live in a separate membership table users cannot self-edit; RLS enforces it |
| 10 | Scraper/provider credentials stored as plaintext application rows | Encrypted vault, service-role/runner-only, never a normal app row |
| 11 | Leaking raw UUIDs / `raw_payload` / `fact_json` / `before_json` diff blobs | Expose booleans/labels and opaque list-keys only; keep internal ids and raw blobs server-side |

Each row is detailed below with the evidence and the "what to do instead."

---

## 1. Secrets in the repo / private keys at rest

**What the old app did.** **[FACT]** Integration secrets were stored in **plaintext at rest** in
Firestore at `IDCApps/{appId}/private/scraperCredentials` — including AWS secret keys, Google
service-account **private keys**, and OAuth/basic-auth secrets, with **no KMS or encryption**
(`scraperConfigManager.js:122-128, 284-289`; schema `scraperConfigSchema.js:282-407`). They were
hidden from the browser by a Firestore rule (`if false`) but were **readable by any Cloud
Function, any admin, and any backup actor** (`current-security-risk-map.md` P0 #1). A related
low-level habit: a service-account key's prefix/length was written to logs
(`googleScraper.js`, P3 #24).

**Why it is unsafe.** A secret that exists in readable form anywhere — a repo, a database row, a
log line, a backup — is a secret that will eventually leak. One over-broad function, one
exported backup, one debug log, and every connected customer system is compromised at once. A
committed `*.key`/`*.pem`/`.env` is permanently in git history even after you "delete" it.

**The v3 safe pattern.** **[FACT]** Secrets are envelope-encrypted and held behind a **KMS**
(Key Management Service — an external service that holds the master key so the key itself never
leaves it) boundary; the database stores only ciphertext, and decrypt authority is isolated to a
separate runner identity (`42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md`, `44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL.md`).
The repo's own hygiene backs this: `.gitignore` excludes `.env*` (opting in only `.env.example`)
and `*.pem` **[FACT]** (`/Users/samvemuri/code/idcaddie-v3/.gitignore` lines 25, 34, 43).

**Finding from this review (existence only — contents NOT read).** A `.env.local` file exists at
the repo root (`/Users/samvemuri/code/idcaddie-v3/.env.local`) alongside `.env.example`. **[FACT]**
`.env.local` matches the `.gitignore` `.env*` rule and is **not** the exempted `.env.example`, so
it should not be tracked by git. **[INFERENCE]** This is the expected/safe posture (local secrets
stay local); its contents were deliberately not opened.

**What to do instead.**
- Never put a secret in source, a migration, a fixture, a test, a doc, or a commit message.
- Keep secrets in `.env*` (gitignored) locally and in a KMS-backed store for anything shared.
- If you discover a secret in a readable place, **report it, do not open it.** Treat the
  *existence* as the finding.

---

## 2. Service-role/Admin SDK in the request path with ad-hoc role checks

**What the old app did.** **[FACT]** Privileged operations ran as `httpsCallable` Cloud Functions
using the Firebase **Admin SDK** (full service-account trust that bypasses all database rules),
and authorization was a **hand-written check inside each function** — inconsistent, and in
several cases **missing entirely**: `sendVerificationEmail`, `syncAppApps`,
`calculateFieldValues`, and `sendUserInviteEmail` shipped with **no auth check at all**; others
(`retryProcessUserlistFile`, `rebuildPeople`, `manualCalculateMonthlyBilling`) checked that a
user was logged in but **not their role** (`current-security-risk-map.md` "Functions callable by
authenticated (or unauthenticated) users"; P1 #8).

**Why it is unsafe.** When the code runs as a super-user and each handler re-implements its own
access check, security becomes "correct only if every author, in every handler, forever,
remembers to write the right check." The evidence shows that failed: whole functions had none.
One forgotten check on a full-trust path is a full-tenant breach.

**The v3 safe pattern.** **[FACT]** Authorization lives in **RLS** (Row Level Security —
Postgres per-row access policies), not in application code. Requests run through a **user-scoped**
database client, so the database itself enforces who can see or change each row; the app does not
re-decide it per handler (`02_SECURITY_AND_RLS.md`; `v3-security-model.md` "Authorization lives in
Postgres RLS, not in frontend filtering"). Server-only Data Access Layer (**DAL** — the
`src/lib/data/*` modules) functions use the user's client and pass **no** service role. See the
canonical example in `src/lib/data/audit.ts` ("No service-role, no writes").

**What to do instead.**
- Put the rule in an RLS policy + a test, once, at the table — not in a handler.
- Never use the service role / an admin client on a normal user request route.
- The only permitted elevated-privilege path is a reviewed, isolated background worker that
  **re-derives tenant authorization** before it writes (see §6 and `16_...EXTRACTION_DESIGN.md`
  §"Service-role isolation").

---

## 3. Client-side tenant filtering as the security boundary

**What the old app did.** **[FACT]** The browser talked to Firestore directly (~198 direct
client call sites across 54 files) and the app relied on **client-side filtering** to decide what
a user should see (`frontend-v2/src/context/DataProvider.js:47-62`) — filtering the audit map
itself flags as "**NOT a security boundary**" (`current-security-risk-map.md` P0 #6).

**Why it is unsafe.** Anything the browser filters, the browser can un-filter. A user can open dev
tools, edit the client code, or call the data store directly and simply skip the filter. If the
only thing standing between tenant A and tenant B's data is JavaScript running on the user's
machine, there is effectively no boundary.

**The v3 safe pattern.** **[FACT]** The **browser is untrusted.** Every customer-owned row carries
a `tenant_id`, and a user can read a tenant's rows only via an active membership, enforced by RLS
in the database (`v3-security-model.md` "Tenant boundary"). DALs deliberately pass **no** tenant
filter from the app and let the database scope the rows — see `src/lib/data/audit.ts`
("We pass no tenant filter; the database scopes the rows").

**What to do instead.**
- Never trust a client-sent `tenant_id`, `org_id`, or resource id to scope a query.
- Write the query as if the caller is hostile; let RLS return only their rows.
- Client-side filters are for **UX** (a search box), never for **authorization**.

---

## 4. Blanket authed reads of whole collections

**What the old app did.** **[FACT]** Any authenticated user could `list` entire collections —
`IDCApps`, `invoices`, `contracts`, `groups` (`firestore.rules:75,150,176,295`) — because a
Firestore `list` skips per-document rules; and **any** authenticated user could read **every**
user profile (`firestore.rules:12`) (`current-security-risk-map.md` P1 #9).

**Why it is unsafe.** "Logged in" is not "authorized to see everything." A blanket list turns any
account — including the lowest-privilege one — into a full-collection export. This is how the
lowest-privileged user ends up able to enumerate every company's contracts or every user's email.

**The v3 safe pattern.** **[FACT]** Tables are **default-deny**: RLS is enabled and there is **no**
`SELECT` policy until a reviewed one is added, so nothing is readable until access is explicitly,
narrowly granted (glossary in `02_SECURITY_AND_RLS.md`). Reads are scoped per row (e.g. read an
app-user only if you can read its app), not per collection.

**What to do instead.**
- Start every new table default-deny; add the narrowest `SELECT` policy that the feature needs,
  with a test proving tenant A cannot read tenant B.
- Never ship a "read all rows of X for any logged-in user" path.
- If a page needs a list, it lists **the caller's** rows via RLS, not the collection.

---

## 5. Raw JSON / whole-document dumps to the client

**What the old app did.** **[INFERENCE, grounded]** Because the browser read Firestore documents
directly (§3), the client received **whole documents** — every field on `IDCApps`, `users`,
`contracts`, etc. — rather than a curated projection. **[FACT]** The AI path made this explicit:
extracted output was stored as `{ ...parsedResponse }` with the instruction to "**extract ALL
fields, not just predefined ones**," plus raw `vertexAISummary` and `documentAIEntities` saved
onto the file document (`16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md` §0, legacy anti-pattern table).

**Why it is unsafe.** A raw dump leaks whatever happens to be on the record — internal flags,
other users' identifiers, provider metadata, half-finished fields — and it silently grows: add a
sensitive column later and it ships to every client that reads the document. "Send the whole
object" is how private fields escape without anyone deciding they should.

**The v3 safe pattern.** **[FACT]** DALs build a **safe DTO** (Data Transfer Object — a small,
explicit shape) by selecting only the columns the UI needs and mapping them deliberately. The
canonical example (`src/lib/data/audit.ts`) selects an explicit safe subset and comments that it
**deliberately does not** expose `tenant_id`, raw actor id, `resource_id`, `ip_address`,
`user_agent`, or the `before_json`/`after_json` blobs.

**What to do instead.**
- Define the DTO first; select only those columns; never `select *` to the client.
- Adding a field to a client response is a decision — make it deliberately, per field.
- For AI/model output, parse against a **strict allowlist schema** and **drop everything else**
  (see §11 and `16_...EXTRACTION_DESIGN.md` §7).

---

## 6. Connector-secret exposure

**What the old app did.** **[FACT]** Beyond storing them in plaintext (§1, §10), the legacy
design let integration secrets be reachable by any function/admin/backup actor, and leaked
secret-shaped material into logs (service-account key prefix/length,
`googleScraper.js`; `current-security-risk-map.md` P0 #1, P3 #24).

**Why it is unsafe.** A connector secret is a key to a *customer's* system. If it can appear in a
log, an error message, an export, a browser payload, or a decrypt endpoint, then the blast radius
is every connected customer, not just ours.

**The v3 safe pattern.** **[FACT]** Envelope encryption with a per-secret data key wrapped by a
KMS-held master key; the database stores **ciphertext only**; **decrypt capability is isolated to
the runner identity** (a normal request/web identity holds no `kms:Decrypt`); logs and errors are
**redacted** and carry identifiers only, never secret content; there is **no endpoint that returns
a decrypted token** — a connector uses the token server-side and it is never returned to the
browser (`42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md` §11; `44_..._THREAT_MODEL.md` §"Forbidden in
the ingestion path"). Client-facing shapes are metadata-only DTOs (no token, no ciphertext, no
sensitive key id).

**Status / governance.** **[FACT]** This vault is built and exercised **on staging only**;
**RISK-007 is OPEN**, **Phase C is BLOCKED**, and **no live customer sync has run**
(`52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`; `57_CONNECTOR_PARITY_REGISTER.md`). Do not treat the
vault's existence as permission to handle a real secret or run a live sync.

**What to do instead.**
- A secret is encrypt-on-save, decrypt-only-by-the-runner. Never add a "read the token" route.
- Redact by default: log the connector id / run id, never the secret or the response body
  (response bodies carry PII — Personally Identifiable Information — and are never logged).
- Any new secret-handling step is a **gated exception** pending RISK-007 — flag it, don't ship it.

---

## 7. Browser-minted show-once API / SCIM / ingestion tokens

**What the old app did.** **[FACT]** Mixed and partly unsafe. API keys
(`createAPIKeyFunction.js:36-44`) and SCIM tokens (SCIM = System for Cross-domain Identity
Management, the standard for provisioning users from an identity provider;
`scim/scimTokenManager.js:23-34`) were SHA-256 **hashed and show-once** — the good pattern. But
**ingestor tokens** (`generateIngestorToken.js:54-58`) and **inbound-email tokens**
(`generateInboundEmailToken.js:20-30`) were **plaintext / id-as-secret**, compared
**non-constant-time** (`handleIngestData.js:42`); and an auto-created scraper ingestor token used
`Math.random()` with `validUntil: null` — **never expiring** (`automatedScrapingService.js:501-505`).
SCIM revoke didn't clear the 5-minute token cache, and an env-var fallback was compared with `===`
(`scimTokenManager.js:42-54` vs `:120-123`; `scim/index.js:28-49`) (`current-security-risk-map.md`
"Credential / token handling", P1 #10).

**Why it is unsafe.** A plaintext token stored as-is is a secret sitting in the database (§1). An
id-used-as-a-secret means the identifier *is* the password. `Math.random()` is predictable and not
cryptographic. A non-constant-time compare leaks the token through timing. A never-expiring,
un-revocable token is forever. Any one of these turns "an integration key" into "a permanent
unauthenticated backdoor."

**The v3 safe pattern.** **[FACT/INFERENCE]** Keep the good half of the legacy behavior and fix the
rest: tokens are **server-issued**, **hashed at rest** (store the hash, show the plaintext once),
generated with a **cryptographic** RNG, **constant-time** compared, **expiring**, and **truly
revocable** (revocation must actually invalidate, including any cache). This is the stated v3 rule
(`v3-security-model.md` "Hashed tokens, real revocation"). **[FACT]** The connector OAuth path
already models the strict version: the browser only ever carries an opaque, HMAC-signed `state` +
a one-time `code` — **never a token** (`44_..._THREAT_MODEL.md`).

**What to do instead.**
- Never let the browser mint or hold the real secret; the server issues it, hashes it, shows it
  once, and stores only the hash.
- Always set an expiry and a working revocation path; never `Math.random()` for anything secret;
  always constant-time compare.

---

## 8. Unauthenticated token-gated public report views that bypass RLS

**What the old app did.** **[FACT]** A public/tokened monthly-summary read path existed
(`webapp/functions/src/monthlySummaryTokens/getMonthlySummaryByToken.js`,
`confirmMonthlySummary.js`) — a report viewable by anyone holding a token in a URL, outside the
normal authenticated, rule-checked path (`43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md`:215, :589-594).
Separately, scheduled/manual reports emailed company-wide financials and owner emails as
**unencrypted HTML**, and a custom report builder could export arbitrary admin-selected fields
(`reportScheduleRunner.js:214-234`; `current-security-risk-map.md` P2 #18).

**Why it is unsafe.** A "view this report" link that works without logging in is authorization by
URL possession: forward the link, leak it in a referrer header, sit it in an inbox, and the data
is exposed — and because it bypasses the normal path, RLS never gets a say. Emailing financials as
plaintext HTML has the same problem in a different envelope.

**The v3 safe pattern.** **[FACT/INFERENCE]** If such a view is ever rebuilt, the legacy ledger
itself requires: **scoped tokens, expiry, tenant binding, a safe public read projection, an audit
record, and no broad report access** — "sender-side parity alone is not enough"
(`43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md`:215). **[INFERENCE]** The default answer is: don't
build an anonymous view; keep report reads behind auth + RLS, and if a shareable link is truly
required, make it a narrowly-scoped, short-lived, revocable, audited token over a minimal
projection — never a bypass of the authorization boundary.

**What to do instead.**
- Prefer authenticated, RLS-scoped report reads. No "public if you have the link."
- If a share link is unavoidable, it is scoped + expiring + tenant-bound + audited + minimal, and
  it is a reviewed exception, not a default. See `58_AI_FEATURE_PARITY_REGISTER.md` /
  `56_OLD_APP_PARITY_REGISTER.md` for which report surfaces are in scope at all.

---

## 9. Role claim from a user-writable profile field (privilege escalation)

**What the old app did.** **[FACT]** Roles lived across three stores that had to stay in sync — an
auth **custom claim** `token.role`, a mirror on the `users/{uid}` document, and a membership doc —
updated by **separate, non-transactional writes** (`roleChecks.js:7-12`; `userCRUD.js`,
`groupManagement.js`, `onUserCreate.js`), which drift (`current-security-risk-map.md`
"Authorization model"; P1 #11). Group-manager edit rights were **not group-specific**: being a
manager in *any* group plus a member of *any* of a resource's groups granted edit — a
**cross-group privilege escalation** the rule's own comment admits and defers to the frontend
(`firestore.rules:388-409`, P0 #5). Permission changes also didn't take effect until token refresh
(~1h), and revocation didn't force it (P1 #12).

**Why it is unsafe.** If a role lives on a record the user (or a loosely-guarded process) can
influence, then editing your own record edits your own permissions — self-promotion. When the same
role is denormalized across three stores by non-transactional writes, they disagree, and the
disagreement is exploitable. When a permission grant is broader than intended (any-group manager),
users reach resources they were never meant to touch.

**The v3 safe pattern.** **[FACT]** Roles live in a dedicated membership table
(`tenant_memberships`), enforced by RLS with **exact** per-org/per-resource joins, and the model
explicitly **blocks tenant-admin self-promotion to owner** with split owner/admin membership
policies and a tenant-binding trigger (`02_SECURITY_AND_RLS.md` §6, scenario T16;
`v3-security-model.md` "Exact per-org/per-resource role checks"). Stewardship writes require the
specific owning org (not merely "related"), so a broad-membership escalation cannot occur
(`v3-security-model.md` "Stewardship vs. read").

**What to do instead.**
- Never read a user's role/permission from a field the user can write. Roles are membership rows
  under RLS, not profile fields, not client claims.
- Make role checks exact (this org, this resource), never "any group / any membership."
- Prove it with a test: a tenant admin cannot self-promote; a manager cannot escape to unrelated
  resources.

---

## 10. Scraper/provider credentials stored as plaintext application rows

**What the old app did.** **[FACT]** The 52+ connector integrations kept their credentials as
plaintext application data at `IDCApps/{appId}/private/scraperCredentials` — an ordinary
(if rule-hidden) data row holding AWS secret keys, Google service-account private keys, and
OAuth/basic-auth secrets, with no encryption (`scraperConfigManager.js:122-128, 284-289`;
`current-security-risk-map.md` P0 #1). This is §1's problem viewed from the connector angle, and
it is the single highest-blast-radius legacy defect.

**Why it is unsafe.** A connector credential in a normal app row inherits all of §1's exposure
(any function/admin/backup can read it) *and* sits inside the same store the product reads and
writes all day — the most-touched, most-likely-to-leak surface in the system. One connector
credential is a live key into a customer's identity provider or cloud account.

**The v3 safe pattern.** **[FACT]** Connector credentials are **never** an application row. They
live in the two-tier vault: metadata in `connectors` (no token, no key, no ciphertext) and the
secret as an encrypted envelope in `connector_secrets` (default-deny; not readable by any normal
role), writable only via reviewed server paths and decryptable only by the runner
(`42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md` §"Data model", §10-11). **[FACT]** This whole path is
staging-only and gated by RISK-007 (OPEN) / Phase C (BLOCKED); zero connectors are live
(`52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md`, `57_CONNECTOR_PARITY_REGISTER.md`).

**What to do instead.**
- A credential never becomes a column on a product table. It is vault + KMS + runner-only, always.
- If you are porting a connector, port the *discovery/sync behavior*, and leave the *credential*
  to the vault path — which is not open for live use yet.

---

## 11. Leaking raw UUIDs, `raw_payload`, `fact_json`, and `before_json`

**What the old app did.** **[FACT]** Audit records carried full before/after change blobs
(`logs/{id}` shape: `changes{before, after}`, `current-product-map.md`), and the client received
whole documents including internal identifiers (§3, §5). Actor attribution was read from
**forgeable client-supplied** document metadata (`uploadedBy`), and most automated/import writes
were attributed to a literal `'system'` rather than a real user
(`16_...EXTRACTION_DESIGN.md` §0; `current-security-risk-map.md` P1 #14).

**Why it is unsafe.** Raw internal fields are an information leak and an enumeration aid: a raw
`tenant_id`/actor/resource UUID (Universally Unique Identifier — an internal record id) tells a
client about records and tenants it should never learn about; a `before_json`/`after_json` diff or
a connector `fact_json`/`raw_payload` can carry sensitive internals, other users' data, or even
secret-shaped values that were never meant to leave the server. Trusting a client-supplied actor
id makes the audit trail forgeable.

**The v3 safe pattern.** **[FACT]** Expose **booleans and labels, not raw internals.** The audit
DAL exposes `actorRecorded: boolean` — "whether an actor was recorded, **NOT** the raw actor id" —
and never selects `tenant_id`, `resource_id`, `before_json`, or `after_json`; the row's own `id` is
used **only as a list key**, never as a tenant/actor/resource id (`src/lib/data/audit.ts`).
**[FACT]** Connector facts keep the raw `fact_json` server-side and route unknown/ambiguous facts to
human review rather than to the client (`42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md` §"redaction",
lines ~2522, ~2719). **[FACT]** Audit actor identity comes from the database side
(`SECURITY DEFINER` trigger using `auth.uid()`), never from a client-supplied field
(`16_...EXTRACTION_DESIGN.md` §0, §8).

**What to do instead.**
- Default to exposing a boolean/label/opaque list-key; a raw UUID or a raw JSON blob leaving the
  server is a decision that needs justification, not a default.
- Keep `raw_payload` / `fact_json` / `before_json` / `after_json` server-side; if a diff must be
  shown, render a curated, redacted projection.
- Never trust a client-supplied actor id; derive the actor server-side from the authenticated
  session.

---

## Fast checklist for AI coding agents (and reviewers)

Before you write or approve code that touches data, secrets, or the browser, confirm **all** of:

1. **No service role on a request path.** Am I using the user-scoped client so RLS decides access?
   (§2)
2. **No client-trusted scoping.** Did I avoid trusting any client-sent `tenant_id`/id to scope a
   query? (§3)
3. **Default-deny.** Does every new table start with RLS on and no `SELECT` policy until a reviewed
   one is added, with a tenant-A-can't-read-tenant-B test? (§4)
4. **DTO, not dump.** Am I selecting an explicit safe column set, not `select *` / a raw document /
   an unbounded model output? (§5, §11)
5. **No raw internals out.** Am I exposing booleans/labels and opaque list-keys, keeping raw UUIDs
   and `*_json` blobs server-side? (§11)
6. **No secret anywhere readable.** No secret in source/migration/test/log/commit; tokens hashed +
   expiring + revocable + constant-time compared + server-issued. (§1, §7)
7. **Roles are membership rows.** No permission read from a user-writable field; role checks exact
   per-org/per-resource. (§9)
8. **Connector secrets untouched.** I am not handling a real secret or running a live sync —
   RISK-007 is OPEN, Phase C is BLOCKED, and any such step is a gated exception to flag, not ship.
   (§6, §10)
9. **I did not read a secret's contents.** If I found a `*.key`/`*.pem`/`.env`/token, I reported its
   existence and did not open it. (top rule)

If any answer is "no" or "unsure," **stop and escalate** — do not copy the legacy shape to make it
work.

---

## The safe-rebuild pattern that replaces all of the above

**[FACT]** The proven v3 recipe (demonstrated by PRs #257–#264) is: a **new read-only page/section**
backed by a **user-scoped RLS DAL** + a **pure helper** + **render/unit tests**, with **zero
migration**, **no service role**, **no client-side tenant filter**, ids-used-as-keys and
booleans (not raw internals), and **fail-closed** behavior. When in doubt, build that shape.

The old app tells you **what** the product should do. This document, plus the RLS model in
`02_SECURITY_AND_RLS.md`, tells you **how** to build it safely. When they disagree about *how*,
the old app loses.

---

## Sources and cross-references

**Rebuild pack (the other 6 docs):** `55_REBUILD_STATUS.md`, `56_OLD_APP_PARITY_REGISTER.md`,
`57_CONNECTOR_PARITY_REGISTER.md`, `58_AI_FEATURE_PARITY_REGISTER.md`,
`59_WORKSTREAM_ROADMAP.md`, `61_NEXT_3_DAYS_PLAN.md`.

**Primary evidence used here:**
- `docs/current-security-risk-map.md` — the read-only legacy audit with exact `file:line` citations
  (the source for every legacy [FACT] above).
- `docs/current-product-map.md` — legacy feature/collection inventory.
- `docs/02_SECURITY_AND_RLS.md` — canonical v3 authorization / RLS model.
- `docs/v3-security-model.md` — legacy-finding → v3-rule mapping.
- `docs/16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md` §0 — the AI-path anti-pattern table.
- `docs/42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md`, `docs/44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL.md`
  — the connector-secret vault and forbidden-list.
- `docs/43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md` — legacy source-line rebuild requirements
  (public-report-token rule).
- `docs/04_RISK_REGISTER.md`, `docs/52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md` — RISK-007 status
  (OPEN) and the Phase-C (BLOCKED) governance.
- `src/lib/data/audit.ts` — the canonical safe DAL/DTO example (no service role, no tenant filter,
  booleans-not-raw-ids, explicit safe column subset).

> This review was read-only. It did not run git or any hosted/network command and did not open any
> secret file's contents; where a `.env`/secret file exists, only its existence is recorded.
