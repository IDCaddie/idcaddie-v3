# 54 — Reusable connector framework (design)

**Status: DESIGN / planning only.** No code here. Scope: a semi-reusable connector framework so future SaaS apps are added
mostly through **reviewed provider manifests** interpreted by **one generic executor**, not per-provider scraper code. First
provider is **Slack**, but nothing here is Slack-only. **This does not touch RISK-007 closure** — that is a separate track and
**RISK-007 remains OPEN; Phase C remains BLOCKED** (see §8).

## 0. This is NOT greenfield
The secure foundation is already built and staging-proven. This framework **evolves existing modules**, it does not replace them:

| Existing (reuse) | Where | Role in the framework |
|---|---|---|
| `provider-registry.ts` | `v3 src/lib/server/connector-vault/` | pure-data provider metadata (ids, auth kind, category, status). Manifests become its declarative backing. |
| `providers/` (`slack-oauth`, `slack-authorize-pending`) | `v3 …/connector-vault/providers/` | provider-specific OAuth front-half (kept; auth is out of the sync manifest). |
| `discovery-facts.ts` (zod, `DISCOVERY_FACT_SCHEMA_VERSION = 1`) | `v3 …/connector-vault/` | **the normalized output schema** — sync emits these validated facts. |
| `slack-discovery-emitter.ts`, `okta-discovery-emitter.ts` | `v3 …/connector-vault/` | today's **imperative** normalizers. The framework makes these **declarative** (manifest + field-map). |
| `connector_runs` (migration `0017`) | DB | sync-run tracking (status/`items_seen`/`error_class` — a class, never a raw message). |
| runner decrypt/use + `runner-connection.ts` `ALLOWED_SQL` | `connector-runner` | token access (KMS, runner-only) + fail-closed DB allowlist. Sync reuses both verbatim. |
| ECS one-shot gate pattern (RUN GATE A/B) | `connector-runner` | INERT-by-default, staging-only, guarded, `--synthetic`, live-after-guards. Sync is another such task. |

**The change in one line:** move from **provider-specific emitters** to **reviewed provider manifests interpreted by one
generic executor**, so a new provider is a reviewed *manifest + field-map*, not a new module.

## 1. Architecture
```
 REVIEWED CONFIG (idcaddie-v3, human-gated)          GENERIC ENGINE (connector-runner, ECS one-shot)
 +-------------------------------+                   +------------------------------------------------+
 | manifests/slack.v1.json       |   vendored +      | connector-sync-task.ts  (guarded, INERT)       |
 | manifest-schema.ts (zod)      |   drift-tested    |  -> decrypt token (runner-only KMS capability) |
 | manifest-validate.ts (CI gate)| ----------------> |  -> executor: build req -> rate-limit -> fetch |
 | field-map.ts (dot-paths only) |                   |       -> retry -> validate envelope+items      |
 +-------------------------------+                   |       -> map fields -> normalized fact         |
        reuses |                                     |  -> paginate (cap) -> write facts + run row    |
        v                                            +------------------------------------------------+
 provider-registry.ts . discovery-facts.ts (zod)              reuses |
 identity-match / resolver . connector_runs                          v
                                                     runner-connection (ALLOWED_SQL) . decrypt/use
                                                     . lifecycle-aware read . redaction discipline
```
Inherited invariants (not re-litigated): the token lives **only** in the runtime `Authorization` header (never in a manifest,
never logged); reads go through the vault decrypt/use capability, so a **revoked/superseded token fails closed**; all DB
access is `SET ROLE connector_runner` + `ALLOWED_SQL`; every row is tenant-scoped; logs are `error_class` + metrics only.
**Read-only, pull-only, staging-only, one-shot** — same discipline as RUN GATE A/B.

**Manifests are code, not data-plane input (§3).** They are reviewed, **image-baked** artifacts (vendored from v3 with a
byte-provenance drift-test, exactly like the vendored SQL). They are **never** loaded from a tenant, a DB row, or an env var.

## 2. Proposed file structure
```
idcaddie-v3/src/lib/server/connectors/           # reviewed config + schema (human-gated)
  manifest-schema.ts        # zod: ProviderManifest + EndpointConfig (.strict(); no unknown keys)
  manifest-validate.ts      # validator used by CI + the runner load path
  field-map.ts              # dot-path resolver (data only - no expressions/code)
  manifests/
    slack.v1.json           # the Slack manifest (see §3)
  # REUSES ../connector-vault/: provider-registry.ts, discovery-facts.ts, identity-match-write.ts

idcaddie-connector-runner/
  src/connector-sync/
    executor.ts             # generic request -> validate -> map -> emit
    paginator.ts            # cursor | page | offset | link | none  (+ max caps)
    rate-limiter.ts         # token bucket + 429/5xx retry policy
    provider-http-client.ts # generic (Bearer / api-key header only)
    fact-write-store.ts     # adapter: allowlisted discovery-fact INSERT + connector_runs
  vendor/connectors/manifests/slack.v1.json   # vendored copy + drift-test vs the v3 SHA
  connector-sync-task.ts    # ECS entrypoint (guards, --synthetic, live-after-guards)
  deploy/task-definition-connector-sync.json
```

## 3. Slack v1 manifest (`slack.v1.json`)
`provider_id` must be in the existing `ConnectorProviderId` allowlist (`slack`, `google_workspace`, `okta`,
`microsoft_entra`, `zoom`, `atlassian`, `github`).
```jsonc
{
  "manifest_version": 1,
  "provider_id": "slack",
  "auth": { "kind": "oauth2", "token_kind": "oauth_access", "header": "bearer" }, // NO secret value here
  "base_url": "https://slack.com/api",           // host in the per-provider allowlist
  "rate_limit": { "rps": 18, "burst": 5 },
  "budget": { "max_requests": 500, "max_items": 100000, "max_wallclock_s": 600 },
  "endpoints": [
    { "id": "auth.test", "method": "GET", "path": "/auth.test",
      "emits": "none", "response": { "ok_path": "ok" }, "required_scopes": [] },

    { "id": "users.list", "method": "GET", "path": "/users.list",
      "query": { "limit": 200 },
      "pagination": { "style": "cursor", "cursor_param": "cursor",
                      "next_path": "response_metadata.next_cursor",
                      "items_path": "members", "max_pages": 200 },
      "emits": "app_user_account",               // EXISTS in FactType today
      "item_schema_ref": "slack_user",
      "field_map": {                             // dot-paths ONLY (no expressions)
        "app_user_external_id": "id",
        "display_name": "profile.real_name",
        "email": "profile.email",
        "is_active": "!deleted",                 // single allowlisted negation token
        "usage_source_ts": "updated" },
      "required_scopes": ["users:read", "users:read.email"] }

    // usergroups.list -> emits a "group" entity, which has NO FactType today (see Open Decision, §7).
    //   BLOCKED on discovery-fact schema v2. Not shippable in v1 until that decision is made.
    // usergroups.users.list -> group_membership, introduces a bounded for_each fan-out. Deferred to Phase 1.5.
  ]
}
```
**Normalized output = reuse `discovery-facts.ts`.** `users -> app_user_account`; `apps -> app_discovery /
app_instance_identity`; `memberships -> group_membership`. The **only gap** is a standalone group entity (Slack usergroup /
Okta group) — see the Open Decision (§7).

## 4. Security review checklist (per manifest PR — CI + human)
- [ ] **No executable code** — pure JSON; `field_map` values are dot-paths + one allowlisted `!` negation. No
      templates / JS / expressions / regex.
- [ ] **No secrets** — secret-shape scan (`xox...`, `AKIA`, `Bearer ...`, `://user:pass@`) rejects; schema has no
      token/credential field; the token is injected only at runtime from the vault.
- [ ] **Allowlisted auth** — `auth.kind` in `{oauth2, api_key}`; `header` in `{bearer, api_key_header}`.
- [ ] **Allowlisted methods** — every sync endpoint `method === "GET"` (POST is separately gated, not permitted in sync manifests).
- [ ] **Host allowlist** — `base_url` host in the provider's pinned set; executor refuses cross-host 3xx redirects.
- [ ] **Strict response validation** — envelope `ok_path` truthy; every item validated by the named `item_schema_ref`
      (registered zod, `.strict()`); a non-conforming item/response **fails closed** (no partial emit of garbage).
- [ ] **Tenant isolation** — `SET ROLE connector_runner`; `tenant_id` bound on every read/write; token is
      per-(tenant, connector); manifests are provider-scoped, never tenant-supplied.
- [ ] **Safe logs** — metrics + `error_class` only; never the token, a raw response body, or PII payloads.
- [ ] **Caps present** — `budget.max_requests/max_items/max_wallclock_s` + each paginator `max_pages` set; missing = reject.
- [ ] **Provenance** — the runner's vendored manifest byte-matches the v3 source at a pinned SHA (drift-test); runtime loads
      only image-baked manifests.
- [ ] **Scopes declared** — `required_scopes` subset of the provider's known scope set; surfaced to `granted_scopes_safe` (Phase 3).

## 5. PR breakdown
- **Phase 1 — manifest + generic executor (INERT; no live sync).**
  - **1a (v3):** `manifest-schema.ts` + `manifest-validate.ts` + `manifests/slack.v1.json` + CI validator. Pure data; no runtime.
  - **1b (runner):** `executor.ts` + `paginator.ts` + `rate-limiter.ts` + `provider-http-client.ts`, unit-tested against
    **mocked** provider responses (fixtures) -> asserts validated `discovery-facts` emitted; retry / pagination / cap /
    no-leak behavior. No live sync.
  - **1c (runner):** `connector-sync-task.ts` INERT + `--synthetic` proof (in-memory HTTP + fake token) + vendored manifest +
    drift-test + `deploy:check` task-def.
- **Phase 2 — normalized writes (live-gated, staging, explicit Sam GO):** `fact-write-store.ts` (allowlisted discovery-fact
  INSERT under `connector_runner`) + `connector_runs` recording; first **live read-only** Slack sync
  (`users.list -> app_user_account`), redacted proof, run row. Gated exactly like RUN GATE A/B.
- **Phase 3 — connector status / scopes UI:** resolve the `connectors.status` pending / `granted_scopes_safe` NULL follow-up —
  activation ownership, granted-scopes surfaced, `connector_runs` history shown.
- **Phase 4 — second provider by config:** add a new manifest (e.g. `github` / `google_workspace`) + `item_schema_ref`s +
  field-map — **zero new executor code**. Retiring the existing Okta emitter onto a manifest validates migration. If a second
  provider needs no engine change, reuse is proven.

## 6. What NOT to build yet
- No provider write-back / mutations — read-only, GET-only, pull-only. No webhooks / streaming.
- No runtime / tenant-supplied manifests — reviewed, image-baked only. No AI auto-merge (AI drafts -> human reviews via PR).
- No deep per-app enrichment (`deep_provider_sync`) — discovery-facts first; enrichment is a later per-provider gate.
- No new auth types beyond `oauth2` / `api_key`; no new HTTP methods.
- No expansion of the resolver (`resolution.ts` / identity-match) — emit facts; keep the review-gated matching untouched.
- No expression language / transforms in `field_map` beyond dot-paths + the one `!` — the moment configs can *compute*, they are code.
- Do not couple to RISK-007 closure (§8). No production.

## 7. DECIDED (2026-07-06) — add a standalone `group` fact NOW (additive, NO migration, NO version bump)
`FactTypeSchema` had a **`group_membership`** edge but **no standalone `group`** entity, so Slack `usergroups.list` (and Okta
groups) had no group node. **Decision (Sam):** add a standalone **`group`** fact type now, as a small **additive** change to
`discovery-facts.ts` (a new discriminated-union member): required `group_external_id` + `group_name`; optional
`group_handle`, `description`, `app_id_hint`, `app_instance_key`, `group_type`, `member_count` (nonneg int), `is_active`.

**Correction to the earlier "schema v2 may be needed" language:** it is **NOT** needed.
- **NO DB migration.** `discovery_facts.fact_type` is free `text` (no CHECK constraint) and the fact is stored in
  `fact_json jsonb`; RLS is tenant-role-based, and indexes are generic (`(tenant_id, fact_type)`). Adding a fact type is a
  pure zod change.
- **NO `DISCOVERY_FACT_SCHEMA_VERSION` bump.** Adding a fact type is backward-compatible, and `schema_version` is a single
  `z.literal(1)` — bumping it would *break* every existing fact. It stays **1**.
- **Runner write policy/grants are a LATER (Phase 2) concern, not group-specific.** Live sync writes facts as `SET ROLE
  connector_runner`, but `discovery_facts`'s INSERT policy today is `has_tenant_role(owner/admin/editor)`. Enabling runner
  writes needs a `connector_runner` grant/policy on `discovery_facts` — a Phase 2 migration that applies to **all** fact
  writes, proposed separately, not part of this fact-type addition.
- **Option B (edges only) rejected:** group name/handle/metadata and empty groups have nowhere to live.

`group_membership` links to a `group` by `(tenant, source_provider, app_instance_key, group_external_id)` at read time — a
soft natural-key link, **no FK**.

**Still deferred** until the manifest emits `group` (add `"group"` to `EMIT_FACT_TYPES`) and the executor is ready:
`usergroups.list` in the Slack manifest, its `slack_usergroup` item schema, and the membership fan-out
(`usergroups.users.list` -> `group_membership`). The Slack manifest still ships `auth.test` + `users.list` only for now.

## 8. RISK-007 is a SEPARATE track (unchanged by this doc)
This framework is net-new product work and does **not** advance or alter RISK-007 closure. **RISK-007 remains OPEN; Phase C
remains BLOCKED.** Its remaining gates are unchanged: criterion 15 (permanent source-secret deletion, date-gated `>= 2026-07-10`),
criterion 18 (closure register), criterion 19 (Phase C unblock). No production; staging only.
