# 24 · Staging Environment Variables & Wiring Checklist

**Canonical source for: exactly which environment variables must be configured in Vercel + Supabase
*staging* — and how to wire them safely — BEFORE any hosted staging execution
([20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md) / [22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md)).**
This is an inventory + checklist; it configures nothing.

> ## ⚠️ STATUS BANNER (do not remove)
> - **DOCS-ONLY.** This file changes no environment, connects nothing, deploys nothing.
> - **NOTHING CONFIGURED.** No Vercel variable, no Supabase setting, no project link is created or changed here.
> - **NO SECRETS INCLUDED.** Only variable **names** + classifications + a `set / not set` evidence pattern —
>   **never a value.** Never paste a real value into this doc, a PR, a log, a screenshot, or chat.
> - **NO HOSTED MUTATION.** No `supabase db push --linked`, no bucket/policy creation, no Vercel mutation.
> - **NO PRODUCTION CHANGE.** Production is untouched; **staging is configured + verified before production.**
> - **Does NOT close RISK-001.** Setting staging env vars is necessary plumbing, not a hosted apply; RISK-001
>   stays open until a reviewed staging apply + verification is done and separately approved ([20 §9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)).
> - **Cutover remains BLOCKED.** [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) is the binding cutover
>   authority. OMC/Flywheel is a paying production replacement, **not a pilot.** This doc does not imply v3 is
>   production-replacement-ready.

---

## 1. Purpose & scope

When a human later runs the staging discipline (doc 20) and the Storage bucket runbook (doc 22), the staging
Vercel deployment + the staging Supabase project must already be configured with the right variables. This doc
is the **inventory of what to set** + the **wiring checklist** to set it safely — so the future execution
doesn't improvise env config. It is read-and-record only; it sets nothing.

---

## 2. Environment model

| Environment | What it is | State today |
|---|---|---|
| **Local development** | Developer machine. The only env that runs today; uses `.env.local` (gitignored) populated from the committed `.env.example` template. | exists (local-only) |
| **Hosted staging** | A separate staging Vercel deployment wired to a separate **staging** Supabase project. | **does not exist yet** |
| **Hosted production** | The production Vercel deployment wired to the production Supabase project. | **does not exist yet** |

**Rule:** **staging must be configured and verified before production.** Each environment has its **own**
Supabase project + its **own** variable values; **never reuse a value across environments**, and **never copy
a production value into staging/preview** (or vice versa).

---

## 3. Required staging env var inventory (names + classifications only — NO values)

Classifications: **public** (browser-safe, may be `NEXT_PUBLIC_*`) · **server-only secret** (never `NEXT_PUBLIC_*`,
never the browser) · **staging-only** (set per-environment) · **future/deferred** (not used today; do not set yet).

> Ground truth: v3 reads **only two** variables today (`src/lib/supabase/env.ts`), both **public**. The
> service-role key is **intentionally not read anywhere under `src/`** and must never reach a request path or
> the client bundle.

### 3a. Public / browser-safe (currently used)
| Variable | Class | Scope | Purpose | Status today |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **public** | staging-only value | The staging Supabase project URL. Public by design. | used (`src/lib/supabase/env.ts`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **public** | staging-only value | The staging **publishable anon** key. **Public, not a secret** — RLS is the authorization boundary ([02](./02_SECURITY_AND_RLS.md)); an anon key alone grants nothing without a session. | used (`src/lib/supabase/env.ts`) |

### 3b. Auth / session
| Variable | Class | Scope | Purpose | Status today |
|---|---|---|---|---|
| *(none beyond 3a)* | — | — | v3 auth/session uses Supabase Auth via `@supabase/ssr` (cookie-based session, `src/lib/supabase/{server,client,proxy}.ts`). The two `NEXT_PUBLIC_*` vars above are the only env inputs. **Auth redirect/site URLs are set in the Supabase project's Auth settings (dashboard), NOT as Vercel env vars** — configure them to the staging URL during wiring. | n/a (no extra env var) |

### 3c. Server-only / secret (NOT used today — future/deferred)
| Variable | Class | Scope | Purpose | Status today |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **server-only SECRET** | **future/deferred** | The service-role key. **NOT used by v3 today** (deliberately absent from `src/`). Reserved **only** for a FUTURE isolated, out-of-request trusted job (e.g. an extraction worker) — **never** on a request/browser path, **never** `NEXT_PUBLIC_*`, **never** in the client bundle ([01](./01_ARCHITECTURE.md), [19 §4](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md)). **Do NOT set it in staging until that isolated job exists and is reviewed.** | **deferred — do not set** |

### 3d. Vercel deployment variables
| Variable | Class | Scope | Purpose | Status today |
|---|---|---|---|---|
| *(per-environment scoping)* | config | staging-only | The 3a vars are added in Vercel **scoped to the preview/staging environment** (Vercel's per-environment env-var feature), not the production environment. Vercel platform telemetry (`@vercel/analytics`, `@vercel/speed-insights`) is bare and needs **no** env var (RISK-013). | the 3a vars, set per-env |

### 3e. Future Storage-related variables
| Variable | Class | Scope | Purpose | Status today |
|---|---|---|---|---|
| *(none — no new var)* | — | future | The private bucket name (`contract-files`) is a **code constant** (`src/lib/files/pdf-validation.ts`), **not** an env var; Storage lives in the same staging Supabase project and uses the same `NEXT_PUBLIC_SUPABASE_*` vars. A future signed-URL/extraction worker may use the service-role (3c) in an **isolated job only** — deferred. | **deferred — no new var** |

### 3f. Future connector / vault variables — BLOCKED
| Variable | Class | Scope | Purpose | Status today |
|---|---|---|---|---|
| *(connector tokens / OAuth secrets / service-account JSON / vault key)* | **server-only SECRET** | **future/deferred — BLOCKED** | Connector credentials + the encrypted-vault key. **BLOCKED by [19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md) / RISK-007 until the vault is implemented + tested + reviewed.** **Never collect, request, paste, or set any of these now** (doc 18/19/22 forbid it). | **blocked — do not set** |

### 3g. OAuth-completion handoff variables — parsed in code, NOT set (Phase 8K)

Names and validation rules only. Nothing here is configured anywhere, and setting them would not enable real mode on its
own: `WORKER_ALLOWED_HOSTS` is empty **in code**, so the handoff refuses until a reviewed change adds the worker host.
Full model in [83 §8.6](./83_REAL_OAUTH_COMPLETION_ARCHITECTURE.md).

| Variable | Class | Purpose | Refuses unless |
|---|---|---|---|
| `OAUTH_COMPLETION_WORKER_URL` | server-only, **not secret** | The completion worker's handoff endpoint | exact normalized HTTPS URL, allowlisted host, pinned path `/internal/oauth-completion/handoff`, no credentials/query/fragment |
| `OAUTH_COMPLETION_WORKER_OIDC_AUDIENCE` | server-only, **not secret** | The audience **dedicated** to the completion worker | present; never Vercel's default team audience |
| `OAUTH_COMPLETION_WORKER_PUBLIC_KEY` | server-only, **not secret** (public half) | Seals the authorization code to the worker | base64 **SPKI DER** of an X25519 public key — raw 32 bytes are refused, because they cannot be told apart from Ed25519 |
| `OAUTH_COMPLETION_WORKER_PUBLIC_KEY_ID` | server-only, **not secret** | Names the key the bytes were sealed to | `^[A-Za-z0-9_.:-]{1,128}$` |
| ~~`VERCEL_OIDC_TOKEN`~~ | injected by Vercel | **Not used in Functions** | Build/local-dev path only. In a Function the platform token comes from Vercel’s request context via `getVercelOidcTokenSync()`; application code never reads a header itself, and there is no CLI refresh path (doc 83 §8.4). |

**`OAUTH_COMPLETER_DB_URL` is NOT a V3 variable and must never be set on this project.** Since Phase 8K its presence —
under that name or any other name carrying the `oauth_completer` role — makes the environment gate refuse with
`completer_credential_present`. It belongs to the completion worker's process and nowhere else ([83 §8.1](./83_REAL_OAUTH_COMPLETION_ARCHITECTURE.md)).

---

## 4. Redaction rules

- **Never commit a value.** Variable **names** only live in the repo; values live in Vercel / the Supabase
  dashboard / an approved secret manager.
- **Never paste a secret** into docs, PR bodies, issue comments, logs, screenshots, or chat.
- **Use names + verification evidence only** — record that a var is configured, not what it contains.
- **Mask values as `set` / `not set`** (or `••• set (len N)` at most), **never** the actual content. In
  screenshots, the value field must be hidden/redacted.
- The **anon key is public** (3a) and still should not be pasted into the repo casually — record `set / not set`.
- `.env.local` (local) is gitignored and **must never be committed**; it is not part of staging.

---

## 5. Vercel staging wiring checklist (human-run later; sets vars, applies nothing hosted-DB)

- [ ] **Confirm the Vercel project** (the correct project/team for v3 staging).
- [ ] **Confirm the environment is Preview/Staging, NOT Production** (Vercel env-var scope = Preview/Staging).
- [ ] **Add variables manually in the dashboard or an approved secret manager only** — no values in the repo,
      no values in CI logs.
- [ ] **Confirm no production variables were copied blindly** into staging.
- [ ] **Confirm NO service-role key is exposed to the browser/client** — the service-role var (3c) is **not**
      set at all yet (deferred); if/when set, it is a **non-`NEXT_PUBLIC_`, server-only/isolated-job** var.
- [ ] **Confirm `NEXT_PUBLIC_*` contains only safe public values** (the staging URL + publishable anon key) —
      never a secret behind a `NEXT_PUBLIC_` name.
- [ ] **Confirm server-only vars are NOT prefixed `NEXT_PUBLIC_`** (a `NEXT_PUBLIC_` var is shipped to the browser).
- [ ] Confirm the staging deployment is **explicit** (not an ad-hoc preview) and points at the **staging**
      Supabase project (3a values).

---

## 6. Supabase staging wiring checklist (human-run later; configures Auth settings only, no DB apply here)

- [ ] **Confirm the staging Supabase project ref** (record it redacted if needed; §7).
- [ ] **Confirm it is the staging project, NOT production** (visually verify ref + dashboard name).
- [ ] **Confirm migrations are LISTED before any apply** (repo `0001`–`0013` vs the staging applied list; no
      unknown/duplicate) — and that **any hosted apply is SEPARATELY APPROVED under [20](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)**
      (this doc sets env config only; it does **not** apply migrations or `db push --linked`).
- [ ] **Configure the project's Auth settings** to the staging Site URL + redirect URLs (dashboard, not a
      Vercel env var) — staging values only.
- [ ] **Confirm Storage work uses the [22](./22_HOSTED_STORAGE_BUCKET_APPLY_RUNBOOK.md) runbook +
      [23](./23_STORAGE_STAGING_APPLY_EVIDENCE_TEMPLATE.md) evidence template** — the bucket/policies are NOT
      created here.
- [ ] **Confirm NO production project is touched** (and not reachable from this session).

---

## 7. Verification evidence (record after staging env vars are set — NO values)

Copy into a dated record (e.g. `docs/evidence/staging-env-<date>.md`) and fill in **only after** a separately
approved wiring. **Names + `set/not set` only — never values.**

- **Date / time (with timezone):** `______________________`
- **Executor:** `______________________`
- **Reviewer (independent):** `______________________`
- **Vercel project / environment:** `______________________` (must be Preview/Staging, not Production)
- **Supabase staging project ref** (redacted if needed): `______________________`
- **Confirmed staging, NOT production:** ☐ — executor `____` / reviewer `____`
- **Variable names set** (no values):
  - [ ] `NEXT_PUBLIC_SUPABASE_URL` — `set / not set`
  - [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` — `set / not set`
  - [ ] `SUPABASE_SERVICE_ROLE_KEY` — **not set (deferred)** — confirm `not set`
  - [ ] *(connector/vault vars)* — **not set (blocked — RISK-007)** — confirm `not set`
- **No values pasted anywhere — confirmed:** ☐ — initials `____`
- **Screenshots attached with VALUES HIDDEN/redacted:** ☐ — initials `____`
- **Smoke test result** (e.g. staging app loads + can reach the staging Supabase Auth/anon — redacted): `______________________`
- **Rollback / disable plan** (how to unset/rotate the staging vars if wrong; production never affected): `______________________`
- **No service-role exposed to browser/client — confirmed:** ☐ — reviewer `____`

---

## 8. Non-goals (this doc / PR #44)

This doc/PR does **not**: add real secrets · paste real values · connect Vercel to Supabase · mutate Vercel ·
mutate hosted Supabase · run `supabase db push --linked` · create a Storage bucket · create Storage policies ·
build an upload action/route/UI · implement signed URLs · add connector secrets · deploy production · cut over ·
onboard a customer · add app/route/migration/package/generated-type changes. It is the **inventory + checklist
only**.

## 9. Risk posture

**RISK-001** (no hosted apply), **RISK-002** (`files` not surfaced), **RISK-007** (no credential vault),
**RISK-016** all remain **OPEN**. Cutover stays **BLOCKED** (doc 17). OMC/Flywheel is a paying production
replacement, **not a pilot**. Configuring staging env vars later is plumbing toward a future staging apply —
it is **not** a hosted apply, **not** Storage-ready, **not** upload-ready, and **not** cutover-ready.
