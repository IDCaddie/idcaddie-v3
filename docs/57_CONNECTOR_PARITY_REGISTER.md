# 11 — Connector Parity Register

> **CURRENT CURSOR (updated 2026-07-08):** `idcaddie-v3` main @ `7f7d050`, PRs merged **through #284**.
> `idcaddie-connector-runner` main @ `84ecf6d`. **The "As of 2026-07-07" line below is this register's original snapshot
> date — historical.** Connector-scoped governance (current, 2026-07-10): RISK-007 is CLOSED at its staging-defined criteria; Phase C is UNBLOCKED as a governance state only (C-2c staging live sync completed 2026-07-10 (staging-only; production untouched; connector-runner PR #36)); production
> untouched. **The C-2c connector live data-sync ran on staging only (connector-runner PR #36, 2026-07-10); production untouched. Earlier hosted staging RISK-007 proof steps occurred under gated
> procedures, but those were not Phase C live data-sync.**

**Part of the 7-document rebuild pack.** Companion docs (cross-referenced by filename below):
[55_REBUILD_STATUS.md](./55_REBUILD_STATUS.md) ·
[56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md) ·
[58_AI_FEATURE_PARITY_REGISTER.md](./58_AI_FEATURE_PARITY_REGISTER.md) ·
[59_WORKSTREAM_ROADMAP.md](./59_WORKSTREAM_ROADMAP.md) ·
[60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md) ·
[61_NEXT_3_DAYS_PLAN.md](./61_NEXT_3_DAYS_PLAN.md)

**As of 2026-07-07.** Owner scope: connectors / data-sync (internal workstream **C**).

---

## 0. How to read this document

This register answers one question for a mixed audience (engineers, product, security reviewers,
non-specialists, and future AI agents): **where were the old app's connectors, and what are we building
instead?**

Two honesty rules run throughout:

- **[FACT]** = directly evidenced in a repo file or a governance doc, cited inline.
- **[INFERENCE]** = a reasonable judgement made in this document (e.g. "this provider *could* become a
  manifest connector"). Inferences are labelled and are **not** commitments — the canonical build order lives
  in [59_WORKSTREAM_ROADMAP.md](./59_WORKSTREAM_ROADMAP.md) and
  [41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md](./41_FULL_PARITY_IMPLEMENTATION_ROADMAP.md).

Also distinguish two very different kinds of "done":

- **Old-app parity** = "the old app could do this." The old app had ~52 connectors.
- **Safe-rebuild progress** = "the new app can safely do this *today*." The new app has **zero** live
  connectors and has **never run a real connector sync**. Both statements are true at once. Do not read
  "framework built" as "connectors working."

### Plain-language glossary (acronyms explained on first use)

- **One-off scraper** — a single-purpose block of code written to pull data from one specific SaaS product.
  The old app had ~52 of these, each maintained separately. This is the pattern we are **not** repeating.
- **Manifest connector** — a reviewed, declarative description of a provider (which URLs to call, which fields
  to keep) that is interpreted by **one** shared, generic engine. Adding a provider becomes "write a reviewed
  config file," not "write another scraper." This is the pattern we **are** building
  ([54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md)).
- **discovery fact** — the normalized, validated output of a sync (e.g. one "app user account" record). All
  connectors, whatever the provider, emit the same small set of fact shapes.
- **connector-runner** — a **separate**, inert-by-default worker repo (`idcaddie-connector-runner`) that will
  actually execute syncs, behind a credential vault boundary. It does nothing unless explicitly and repeatedly
  authorized for a single staging run.
- **credential vault** — where a provider's secret (e.g. a Slack token) is stored **encrypted** (envelope
  encryption: a per-secret data key, itself protected by a cloud KMS = Key Management Service). The web app can
  only *save* a secret; only the runner, under a KMS-guarded role, can *decrypt and use* it.
- **RLS** — Row Level Security (Postgres per-row access rules); the sole authorization boundary in the new app.
- **RISK-007** — the governance risk that gates all real connector-secret handling and deletion. It is **OPEN**.
- **Phase C** — the gated phase in which live connector execution ("the connector data-sync") is allowed. It is
  **BLOCKED**. (Note: some older design docs use "Phase C" loosely to mean the ingestion-runner phase; in the
  governance sense used here and in [52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md),
  Phase C = live-sync unblock, criterion 19, still BLOCKED.)

---

## 1. TL;DR

- **[FACT]** The old (Firebase) app had **52 connectors** — one-off scrapers, each pulling an app's user
  roster / inventory / usage — **plus** a "generic API" catch-all connector and a shell-based inbound
  ingestor (`IDCIngestor`). Source: [40_CODE_DERIVED_OLD_APP_INVENTORY.md](./40_CODE_DERIVED_OLD_APP_INVENTORY.md)
  §3 (`webapp/functions/src/appScraping/scrapers`, 52 scrapers found).
- **[FACT]** The new app is **not** rebuilding 52 one-off scrapers. It is building **one reusable,
  manifest-driven connector framework** interpreted by a single generic executor, so new providers are added
  mostly as *reviewed config*, not new code
  ([54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md)).
- **[FACT]** **Slack is the first proof provider.** A `slack.v1.json` manifest exists and the framework's
  Phase 1 landed **INERT** (no live sync). The generic executor and live sync are still unbuilt/unrun.
- **[FACT]** **Zero connectors are live.** No real connector data-sync has ever run. The first-ever staging
  live read-only Slack sync (Phase 2c) is **readiness-only and NOT authorized**.
- **[FACT]** All of this is gated by **RISK-007 (OPEN)** and **Phase C (BLOCKED)**. Production is hard-blocked;
  only the staging Supabase project may be touched.
- **[INFERENCE]** Most of the 52 providers *can* eventually become manifest connectors; a handful (cloud IAM
  providers like AWS/AliCloud, the generic-API and inbound-ingest paths) do **not** fit the current manifest
  model and need separate, gated design.

**The honest one-paragraph summary:** the old app had broad connector ambition and a large plaintext-secret
liability to match; the new app has replaced "52 fragile scrapers + plaintext secrets" with "1 reviewed
framework + an encrypted vault that no live sync has yet exercised." We have the *engine design and the first
manifest*; we do **not** yet have a single working connector.

---

## 2. Where the old connectors are, and what we do instead

### 2.1 The old app (evidence)

**[FACT]** From [40_CODE_DERIVED_OLD_APP_INVENTORY.md](./40_CODE_DERIVED_OLD_APP_INVENTORY.md) §3 and
[43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md](./43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md):

- Connectors lived in `webapp/functions/src/appScraping/scrapers/` — **52 scrapers**, driven by
  `automatedScrapingService`, `runAppScraper`, `runScheduledScrapers`, `configureAppScraper`,
  `testScraperCredentials`, `updateScraperCredentials` (callable + scheduled Cloud Functions).
- Each scraper pulled a provider's **app/user inventory + usage/license/last-active** into the SaaS-governance
  model.
- Credentials were stored via `setAppPrivateData` / `PRIVATE_CREDENTIALS_SCHEMA` /
  `updateScraperCredentials`, at `IDCApps/{appId}/private/scraperCredentials`.
- A **generic API** connector plus **Okta/Atlassian app+user handlers** and a `DemoFeatures/IDCIngestor`
  inbound path (shell ingestors for 1password, asana, atlassian, databricks-prism, intercom, plus
  `IDC_uploader.sh` / `create_IDC_api.sh`) existed alongside the 52.

**[FACT] Security liability of the old pattern** (this is *why* we are not copying it —
[current-security-risk-map.md](./current-security-risk-map.md) §"Integration secrets", and
[60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md)):

- Integration secrets — **AWS secret keys, Google service-account private keys, OAuth/basic-auth secrets** —
  were stored **in plaintext** with **no KMS / no encryption** (`scraperConfigManager.js:122-128,284-289`).
  Browser reads were blocked by a Firestore rule, but the plaintext was readable by any function/admin/backup
  actor.
- The `DemoFeatures/IDCIngestor/**` tree contained **committed private-key files**
  ([43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md](./43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md) §"IDCIngestor").

> **Security discipline for this repo:** the existence of committed private-key files in the *old* app is a
> finding, recorded here and in [60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md). Their
> **contents must never be read, quoted, or ported.** A name-only scan of both new repos (`idcaddie-v3`,
> `idcaddie-connector-runner`) found **no** `*.key` / `*.pem` / private-key files — **[FACT]**, verified by
> filename listing only, contents never opened.

### 2.2 The new app (what we do instead)

**[FACT]** Instead of 52 scrapers, one **reusable manifest-driven framework**
([54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md)):

1. **Reviewed provider manifests** (`src/lib/server/connectors/manifests/*.json`) — pure JSON, no code, no
   secrets, `.strict()` zod-validated, image-baked (never loaded from a tenant, DB row, or env var). A
   manifest says which GET endpoints to call, how to paginate, and which response fields (dot-paths only) map
   to which normalized fact. Each manifest passes a per-PR security checklist (no executable code, no secrets,
   allowlisted hosts/methods/auth, caps present, strict response validation, tenant isolation, safe logs).
2. **One generic executor** in the `connector-runner` — build request → rate-limit → fetch → retry →
   validate → map fields → emit a normalized **discovery fact** → paginate (capped) → write facts + a run row.
   Adding a provider ideally means **zero new executor code**.
3. **Inherited, non-negotiable invariants** — the provider token lives **only** in the runtime
   `Authorization` header (never in a manifest, never logged); reads go through the vault decrypt/use
   capability so a **revoked/superseded token fails closed**; all DB access is `SET ROLE connector_runner` +
   an SQL allowlist; every row is tenant-scoped; logs carry an `error_class` + metrics only, never a token, a
   raw response body, or PII.

**Why this trade-off (for non-specialists):** 52 hand-written scrapers are 52 things to secure, review, and
keep from leaking. A single reviewed engine + declarative configs shrinks the "custom code that touches a real
credential" surface to almost nothing, and makes every provider inherit the same fail-closed, tenant-scoped,
no-plaintext-secret discipline. The cost is that we build slowly and gate hard: **one** provider at a time,
behind an explicit human decision each run.

---

## 3. Connector parity register (all discovered providers)

**How the table is scoped.** The following attributes are **constant** across the 52 SaaS scrapers unless a
row says otherwise, so they are stated once here rather than repeated 52 times:

| Constant attribute | Value (applies to every scraper row below) |
|---|---|
| **Old location** | `webapp/functions/src/appScraping/scrapers/<id>` (Firebase Cloud Functions) — **[FACT]**, doc 40 §3 |
| **Connector type** | One-off scraper (callable + scheduled), pull-only |
| **Old behavior** | Pull app + user inventory + usage / license / last-active into the governance model |
| **New-app status** | **Not built** (framework designed; only Slack has a manifest; no live sync) |
| **Blocked by** | **Yes** — RISK-007 (credential vault, OPEN) **and** Phase C (live sync, BLOCKED). No connector can run until both clear. |

The per-provider table therefore shows only the columns that **vary**: manifest-ability, whether we know the
data/scopes yet, a relative risk band, and a recommended order. Legend:

- **Manifest-able?** — **[INFERENCE]** Can this become a manifest connector under the *current* framework
  (OAuth2 or API-key auth, `bearer`/`api_key_header`, GET-only, JSON responses, dot-path field maps)?
  `Yes` / `Unknown` / `No (needs redesign)`.
- **Data/scopes known?** — Do we have concrete endpoint/scope evidence yet? Only Slack does (**[FACT]**, from
  `slack.v1.json`); everything else is `Not yet inspected` and must be captured before a manifest PR.
- **Risk band** — **[INFERENCE]** relative sensitivity of the stored credential and its blast radius.
  All are RISK-007/Phase-C gated regardless; this band only ranks them relative to each other.
- **Rec. order** — **[INFERENCE]** a suggested sequencing, deferring to
  [59_WORKSTREAM_ROADMAP.md](./59_WORKSTREAM_ROADMAP.md) / doc 41 for the canonical waves. `Phase 1` = the
  Slack proof; `Wave 1/2/3` ≈ near/mid/long term; `Deferred` = needs separate gated design.

> **[INFERENCE] on ordering:** the 7 provider IDs already in the framework's registry allowlist
> (`slack`, `google_workspace`, `okta`, `microsoft_entra`, `zoom`, `atlassian`, `github` — **[FACT]**,
> doc 54 §3) are the natural near-term candidates, and doc 41 labels the first provider wave (E18) as
> okta / google / microsoft365. Identity/directory providers are ranked first because their user + group
> facts feed the identity-matching surface; cloud-IAM providers are ranked last because their credentials
> (service-account private keys, IAM access keys) carry the widest blast radius and do not fit the current
> manifest auth model.

### 3.1 Identity / directory / HRIS providers (highest parity value — feed identity matching)

| Provider | Manifest-able? | Data/scopes known? | Risk band | Rec. order |
|---|---|---|---|---|
| `okta` | Yes | Not yet inspected | High (org-wide identity) | Wave 1 |
| `google` (→ `google_workspace`) | Yes | Not yet inspected | High (org-wide identity) | Wave 1 |
| `microsoft365` (→ `microsoft_entra`) | Yes | Not yet inspected | High (org-wide identity) | Wave 1 |
| `auth0` | Yes | Not yet inspected | High (IAM) | Wave 2 |
| `workday` | Unknown (HRIS; auth may exceed OAuth2/API-key) | Not yet inspected | High (HR/PII) | Wave 3 |

### 3.2 Collaboration / productivity / content providers

| Provider | Manifest-able? | Data/scopes known? | Risk band | Rec. order |
|---|---|---|---|---|
| `slack` | **Yes — manifest exists** | **Yes** (`auth.test`, `users.list`→`app_user_account`, `usergroups.list`→`group`; scopes `users:read`, `users:read.email`) — **[FACT]** doc 54 §3 | Medium | **Phase 1 (in progress, INERT)** |
| `jira` (→ `atlassian`) | Yes | Not yet inspected | Medium | Wave 2 |
| `zoom` | Yes | Not yet inspected | Medium | Wave 2 |
| `notion` | Yes | Not yet inspected | Medium | Wave 3 |
| `asana` | Yes | Not yet inspected | Medium | Wave 3 |
| `wrike` | Yes | Not yet inspected | Medium | Wave 3 |
| `figma` | Yes | Not yet inspected | Medium | Wave 3 |
| `dropbox` | Yes | Not yet inspected | Medium | Wave 3 |
| `egnyte` | Yes | Not yet inspected | Medium | Wave 3 |
| `productboard` | Yes | Not yet inspected | Medium | Wave 3 |
| `lucidchart` | Yes | Not yet inspected | Medium | Wave 3 |
| `contentful` | Yes | Not yet inspected | Low–Medium | Wave 3 |

### 3.3 Developer / data / infrastructure / observability providers

| Provider | Manifest-able? | Data/scopes known? | Risk band | Rec. order |
|---|---|---|---|---|
| `github` | Yes | Not yet inspected | Medium | Wave 2 |
| `githubEnterprise` | Yes | Not yet inspected | Medium | Wave 2 |
| `circleci` | Yes | Not yet inspected | Medium | Wave 3 |
| `dockerhub` | Yes | Not yet inspected | Medium | Wave 3 |
| `octopus` | Yes | Not yet inspected | Medium | Wave 3 |
| `n8n` | Yes | Not yet inspected | Medium | Wave 3 |
| `zapier` | Unknown (automation hub; API model varies) | Not yet inspected | Medium | Wave 3 |
| `launchdarkly` | Yes | Not yet inspected | Medium | Wave 3 |
| `retool` | Yes | Not yet inspected | Medium | Wave 3 |
| `datadog` | Yes (API-key header) | Not yet inspected | Medium | Wave 3 |
| `pagerduty` | Yes | Not yet inspected | Medium | Wave 3 |
| `mongodb` (Atlas) | Yes | Not yet inspected | Medium | Wave 3 |
| `databricks` | Yes | Not yet inspected | Medium | Wave 3 |
| `datarobot` | Yes | Not yet inspected | Medium | Wave 3 |
| `astronomer` | Yes | Not yet inspected | Medium | Wave 3 |
| `sigma` | Yes | Not yet inspected | Medium | Wave 3 |
| `tableau` | Yes | Not yet inspected | Medium | Wave 3 |
| `domo` | Yes | Not yet inspected | Medium | Wave 3 |
| `mixpanel` | Yes | Not yet inspected | Medium | Wave 3 |

### 3.4 Sales / marketing / customer-success / recruiting providers

| Provider | Manifest-able? | Data/scopes known? | Risk band | Rec. order |
|---|---|---|---|---|
| `salesforce` | Yes | Not yet inspected | Medium (CRM/PII) | Wave 3 |
| `salesloft` | Yes | Not yet inspected | Medium | Wave 3 |
| `hubspot` | Yes | Not yet inspected | Medium (CRM/PII) | Wave 3 |
| `marketo` | Yes | Not yet inspected | Medium | Wave 3 |
| `gong` | Yes | Not yet inspected | Medium | Wave 3 |
| `apollo` | Yes | Not yet inspected | Medium | Wave 3 |
| `intercom` | Yes | Not yet inspected | Medium | Wave 3 |
| `zendesk` | Yes | Not yet inspected | Medium | Wave 3 |
| `freshworks` | Yes | Not yet inspected | Medium | Wave 3 |
| `greenhouse` | Yes | Not yet inspected | Medium (recruiting/PII) | Wave 3 |
| `dialpad` | Yes | Not yet inspected | Medium | Wave 3 |

### 3.5 Cloud / network / ITSM providers (widest blast radius — ranked last)

| Provider | Manifest-able? | Data/scopes known? | Risk band | Rec. order |
|---|---|---|---|---|
| `aws` | **No under current model** — IAM/SigV4 signing, not `bearer`/`api_key_header`; needs a new (gated) auth kind | Not yet inspected | **High** (cloud IAM keys) | Deferred |
| `alicloud` | **No under current model** — cloud IAM signing, as AWS | Not yet inspected | **High** (cloud IAM keys) | Deferred |
| `cloudflare` | Yes (API token) | Not yet inspected | Medium–High | Wave 3 |
| `meraki` (Cisco) | Unknown (network appliance; API-key header but different shape) | Not yet inspected | Medium–High | Wave 3 |
| `servicenow` | Unknown (instance-specific table API; auth varies) | Not yet inspected | High (ITSM/PII) | Wave 3 |

### 3.6 Special / non-scraper connector paths (do not fit the manifest model as-is)

| Item | Old location | Type | Manifest-able? | Risk band | Rec. order |
|---|---|---|---|---|---|
| **Generic API connector** (`genericApi`) | `appScraping/scrapers/genericApi` + `api` token mgmt | Tenant-configurable catch-all pull connector | **No (needs redesign).** The framework **deliberately replaces** a tenant-supplied generic endpoint: manifests are reviewed and image-baked, **never** tenant-supplied (doc 54 §1). The generic *capability* is met by adding reviewed manifests, not by rebuilding "point it at any URL." | **High** (arbitrary endpoint + stored creds) | Deferred / redesign |
| **IDCIngestor** (`DemoFeatures/IDCIngestor/**`) | `webapp/functions/.../IDCIngestor` | Inbound / push shell ingestors (1password, asana, atlassian, databricks-prism, intercom) + `IDC_uploader.sh` / `create_IDC_api.sh` inbound API; **contained committed private-key files** | **No.** The framework is **pull-only**; push/inbound is out of scope. Carries a **do-not-copy** secret finding (never read/port the key files — see [60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md)). | **High** (inbound tokens + committed private keys) | Deferred / separate design |

**Provider count reconciliation — [FACT]:** doc 40 §3 states "52 connectors found." §3.1–§3.5 above enumerate
those **52 discrete provider scrapers**; §3.6 covers the **generic API** connector and the **IDCIngestor**
inbound path called out separately in the same doc. (Some names — `asana`, `atlassian`, `intercom`,
`databricks` — appear both as scrapers **and** in the IDCIngestor demo tree.) The canonical facts elsewhere say
"~51 one-off scrapers"; the small discrepancy is only whether `genericApi` is counted among the 52 or listed
as "plus the generic API." Treat the count as **~51–52 provider scrapers + a generic API connector + an
inbound ingestor**; the names above are the authoritative list.

---

## 4. Slack — the first proof provider (current state)

**[FACT]** Slack is the only provider with any implementation, and it is deliberately **inert**:

- A `slack.v1.json` manifest exists (`auth.test`, `users.list` → `app_user_account`, `usergroups.list` →
  `group`) — [54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md) §3, §7.
- The standalone `group` discovery fact landed (**v3 PR #252**); `"group"` is in the emit allowlist and
  `usergroups.list` is declared. Still deferred: the `slack_usergroup` per-item schema, the membership
  fan-out (`usergroups.users.list` → `group_membership`), the **generic executor**, and **live sync** — all
  Phase 1b+ (doc 54 §7).
- Framework Phase 1 (manifest + schema + validator) landed **INERT** — no runtime, no live sync (doc 54 §5).
- On the runner side: **Phase 2a** (the app-repo DB write boundary, **migration 0041** via **v3 PR #255** — three
  `SECURITY DEFINER` writer functions, EXECUTE-only grant to `connector_runner`, direct table INSERT/UPDATE
  revoked) is **applied + verified on staging**. **Phase 2b** (runner live wiring, `idcaddie-connector-runner`
  **PR #33**) is **merged but INERT by default** (synthetic mode is the default; no live run). **Phase 2c**
  (first hosted staging live **read-only** Slack sync — `auth.test` + `users.list` + `usergroups.list`,
  GET-only, no Slack writes, no `auth.revoke`) is **readiness-only and NOT authorized**
  ([CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md](../../idcaddie-connector-runner/docs/CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md)).

**[FACT] What Slack has already safely proven on staging** (redacted, no plaintext — recorded in the runner's
`STAGING_LIVE_RUN_EVIDENCE.md`, tracked in
[52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md)): a real per-tenant Slack
bot token was stored **envelope-only** (RUN GATE A), decrypted and used under the runner-only KMS role for a
real `auth.test` (Phase C decrypt/use), and taken through a vault-version rotation/supersede/revoke lifecycle
(RUN GATE B). **Honest scope caveat — [FACT]:** RUN GATE B rotated the **vault version**, but v2 wraps the
**same underlying Slack token** as v1 (identical fingerprint — Slack re-issued it), so a **provider-side** token
rotation was **not** forced and provider-side `auth.revoke` is deferred. What has **not** happened: **no
connector data-sync has ever run** — no row has yet been written through the Phase 2a write boundary.

---

## 5. What must be true before ANY live connector sync

**[FACT]** A live sync — even a staging, read-only one — is the **first exercise of the Phase C data-sync
path**, so it does not "just follow" from the framework being built. Per
[CONNECTOR_SYNC_PHASE_2_RUNBOOK.md](../../idcaddie-connector-runner/docs/CONNECTOR_SYNC_PHASE_2_RUNBOOK.md) and
[CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md](../../idcaddie-connector-runner/docs/CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md),
**all** of the following are required (else **DO NOT RUN**):

1. v3 migration **0041** reviewed + applied + verified on staging — **DONE** (Gate 2a).
2. `connector_runner` write path verified (EXECUTE-only on the 3 writer functions; no direct table grants;
   vault grants unchanged) — **DONE** (Gate 2a).
3. An **explicit human decision** that a staging live sync is acceptable **while RISK-007 is OPEN** — **PENDING
   (Sam).** This is a governance decision, logged as a pre-closure staging proof; it does **not** mean Phase C
   is unblocked.
4. A **separate per-run human GO** immediately before the hosted run — **PENDING.**
5. Plus: PR 2b merged (**DONE**), the synthetic in-container smoke of the exact image passing, staging-only
   guards + prod-ref hard-block, the enabling env flags set, the exact confirm phrase
   `RUN CONNECTOR SYNC LIVE STAGING`, and redacted evidence capture. The token lives only in the `Bearer`
   header (never logged/persisted); response bodies are never logged (they carry PII); a post-run log scan must
   be **0** hits.

**[FACT] Governance state today:** RISK-007 is **OPEN**; Phase C is **BLOCKED**; production
(`dzbfxulvxchdemcettrx`) is hard-blocked and untouched; only staging (`ycdpzduxugdsffjqyoai`) may be used.
RISK-007's remaining criteria ([04_RISK_REGISTER.md](./04_RISK_REGISTER.md),
[52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md)):

- **Criterion 15** — permanent deletion of the staging **source** Slack client secret; date-gated,
  actionable **only after 2026-07-10** (a 7-day recovery window). Metadata ops only; never read the secret
  value. **[FACT]** Criterion 15 is **independent** of Phase 2c (2c reads a per-tenant *bot* token, not the
  client secret), so it is not a technical prerequisite for a 2c staging proof — but RISK-007 cannot close
  without it.
- **Criterion 18** — draft the RISK-007 closure-register PR, **only after** criteria 3–15 are green. PENDING.
  RISK-007 must **never** be flipped to closed inside a run PR.
- **Criterion 19** — **Phase C unblock**; a separate explicit human decision **after** RISK-007 closes. BLOCKED.

> **Do not** mark RISK-007 closed, **do not** unblock Phase C, and **do not** treat a green staging sync as
> Phase C being unblocked. Any live-sync-before-closure item is a **gated exception** (decision #3 above),
> logged as a pre-closure staging proof only.

---

## 6. Honest caveats — what this document does NOT claim

- **We have an engine design, not connectors.** One manifest (Slack) exists; the **generic executor** and
  **live sync** are unbuilt/unrun. The "add a provider with zero executor code" reuse claim (doc 54 §5 Phase 4)
  is **designed but unproven** — there is one provider and no engine yet.
- **The 52-provider parity gap is almost entirely open.** 51 of 52 providers have **no** manifest, no captured
  scopes, and no owner. Manifest-ability, risk bands, and wave order in §3 are **[INFERENCE]**; each provider
  still needs a real API/scope inspection before a manifest PR.
- **"Green local tests" ≠ "credential path proven."** The vault's KMS/IAM decrypt separation and the runner's
  execution path can only be exercised on hosted staging, not in the local Postgres test harness (doc 48). CI
  green does **not** prove the credential boundary.
- **PR numbers are claims, and they span two repos.** `v3 PR #252 / #255` are `idcaddie-v3`;
  `PR #33` is `idcaddie-connector-runner`. This document did not run git; treat PR numbers as cited claims.
- **AWS / AliCloud / genericApi / IDCIngestor are not "coming soon."** They do not fit the current manifest
  model and are **Deferred** pending separate, gated design — do not schedule them into the manifest waves.

---

## 7. Related documents

**New rebuild pack (this doc is #11):**
[55_REBUILD_STATUS.md](./55_REBUILD_STATUS.md) ·
[56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md) (how these connector rows map into the
overall old-app parity picture) ·
[58_AI_FEATURE_PARITY_REGISTER.md](./58_AI_FEATURE_PARITY_REGISTER.md) (the parallel AI/document-extraction
gap) ·
[59_WORKSTREAM_ROADMAP.md](./59_WORKSTREAM_ROADMAP.md) (**canonical** connector build order / waves) ·
[60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md) (plaintext secrets, committed private keys,
tenant-supplied endpoints — the anti-patterns) ·
[61_NEXT_3_DAYS_PLAN.md](./61_NEXT_3_DAYS_PLAN.md).

**Connector design + evidence (source docs):**
[54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md) (the framework) ·
[42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md](./42_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) (the implemented vault) ·
[44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL.md](./44_CONNECTOR_CREDENTIAL_REAL_TOKEN_THREAT_MODEL.md) ·
[52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md](./52_RISK_007_CLOSURE_EVIDENCE_TRACKER.md) ·
[04_RISK_REGISTER.md](./04_RISK_REGISTER.md) (RISK-007) ·
[40_CODE_DERIVED_OLD_APP_INVENTORY.md](./40_CODE_DERIVED_OLD_APP_INVENTORY.md) and
[43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md](./43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md) (legacy connector
evidence).

**Connector-runner repo (separate repo, `idcaddie-connector-runner/docs/`):**
`CONNECTOR_SYNC_PHASE_2_RUNBOOK.md` · `CONNECTOR_SYNC_PHASE_2C_RUNBOOK.md` · `STAGING_LIVE_RUN_EVIDENCE.md`.

---

*Provenance note: the machine-readable connector-evidence bundle passed to this document was a placeholder
(a single stub "Slack" entry). The authoritative 52-provider enumeration in §3 was therefore taken directly
from the repo evidence — [40_CODE_DERIVED_OLD_APP_INVENTORY.md](./40_CODE_DERIVED_OLD_APP_INVENTORY.md) §3 —
and cross-checked against [43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md](./43_OLD_APP_SOURCE_LINE_REBUILD_LEDGER.md)
and [54_CONNECTOR_FRAMEWORK_DESIGN.md](./54_CONNECTOR_FRAMEWORK_DESIGN.md).*
