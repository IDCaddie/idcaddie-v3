# 27 · Legacy OMC Full Production-Replacement Parity Matrix

**Canonical, row-level parity tracker for replacing the live OMC production app.** This is the detailed
matrix *under* the cutover gate [17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
(§4). Doc 17 is the gate; **doc 27 is the line-item evidence ledger that the gate is satisfied.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **This is a parity CONTROL document.** It **does not implement features**, **does not prove parity**,
>   **does not close RISK-001**, and **does not authorize cutover**.
> - **OMC replacement remains BLOCKED** until every **P0** row is `complete` or `deprecated-approved`.
> - **Full legacy OMC parity is required BY DEFAULT.** OMC is a **live operational production system**, not a
>   pilot or MVP. v3 is judged against **full legacy parity** unless a specific capability is explicitly
>   **deprecated-approved**.
> - **A missing route, workflow, field, report, import, setting, billing flow, or migration item is an OMC
>   blocker** unless explicitly `deprecated-approved`. "Better than legacy" / "contracts done" / "apps done"
>   does **not** satisfy a row — only evidence does.
> - **Do not claim OMC readiness.** v3 is **not** OMC replacement-ready (see §"Current replacement readiness").
> - Most rows below are **`missing` or `blocked-unknown-legacy-behavior`** because the legacy inventory has not
>   been captured. Unknown legacy behavior is a **blocker**, never `complete`.

---

## Definitions

### Row status (use exactly these)
| Status | Meaning |
|---|---|
| `complete` | v3 fully replaces the legacy behavior **with recorded evidence** (route/workflow/RLS test/UI/legacy-comparison + reviewer initials). |
| `partial` | Some of the behavior exists in v3 but not all of it (missing fields, read-only where legacy wrote, no evidence yet, etc.). **Partial ≠ done.** |
| `missing` | No v3 equivalent exists yet. |
| `deprecated-approved` | Legacy behavior is intentionally **not** carried forward, with **explicit recorded approval** (owner + OMC signoff). Not a developer assumption. |
| `blocked-security` | Cannot replace as-is without a security model decision (e.g. legacy did unsafe blind-delete). |
| `blocked-data-migration` | Cannot be `complete` until the underlying data migration + reconciliation is done. |
| `blocked-unknown-legacy-behavior` | The legacy behavior is **not yet inventoried/understood**. Default for un-captured legacy areas. **A blocker, never `complete`.** |

### Blocker level
| Level | Meaning |
|---|---|
| **P0 — OMC blocker** | Cutover is a NO until this is `complete` or `deprecated-approved`. |
| **P1 — replacement blocker** | Required for a credible replacement; must be `complete`/`deprecated-approved` before cutover unless reclassified with approval. |
| **P2 — post-cutover follow-up** | Allowed to trail cutover **only if explicitly approved** as such. Default is *not* P2. |
| **not required / `deprecated-approved`** | Explicitly out of scope with recorded approval. |

### Evidence types (a row may require several)
`route exists` · `workflow test` · `RLS/security test` · `UI screenshot / manual evidence` · `legacy comparison`
· `report output comparison` · `data migration reconciliation` · `OMC signoff` · `reviewer initials`.
**Executor claims alone never satisfy a row** — an independent reviewer's initials are required.

### Canonical 15-field row schema
Every row below conceptually carries these fields (the per-track tables show them terse; **Owner/reviewer =
TBD on every row until assigned**, and **Evidence = none captured yet** unless a cell says otherwise):
**Track · Legacy area · Legacy route/component/function · User-facing behavior · Fields/columns/actions ·
Reports/exports · Data dependency · v3 equivalent · Current v3 status · Required for OMC? · Evidence required ·
Security replacement model · Blocker? · Owner/reviewer · Notes.**

---

## Master matrix (grouped by parity track)

Legend for the compact columns used below: **Legacy** = legacy area/route/behavior · **v3** = v3 equivalent ·
**Status** = row status (above) · **Req?** = blocker level · **Evidence** = evidence required to mark
`complete` · **Sec model** = security replacement model · **Blocker** = is this currently blocking cutover.
Cells are terse; unknowns are `blocked-unknown-legacy-behavior`, **not** done.

### Track A — Full legacy route & screen parity
> **Rule: a missing route = OMC blocker unless explicitly `deprecated-approved`.**

| Legacy screen/route | v3 equivalent | Status | Req? | Evidence | Sec model | Blocker |
|---|---|---|---|---|---|---|
| Dashboard / home metrics | — (none) | `missing` | P0 | route exists + legacy comparison + metric parity | RLS-scoped reads | **YES** |
| Apps list | `/apps` (read-only) | `partial` | P0 | route + list-parity (Track D) + legacy comparison | RLS read | **YES** |
| App detail | `/apps/[id]` (read-only + roster/match/account cards) | `partial` | P0 | route + field parity (Track C) + legacy comparison | RLS read | **YES** |
| Contracts list | `/contracts` (read-only) | `partial` | P0 | route + list-parity + legacy comparison | RLS read | **YES** |
| Contract detail | `/contracts/[id]` (read-only) | `partial` | P0 | route + field parity + legacy comparison | RLS read | **YES** |
| Contract create | `/contracts/new` | `partial` | P0 | workflow test + field parity (Partial per [15]) | RLS write `0004` | **YES** |
| Contract edit | `/contracts/[id]/edit` | `partial` | P0 | workflow test + field parity (Partial per [15]) | RLS write `0004` | **YES** |
| Files list | — | `missing` | P0 | route + Track H + Storage REST verify | private bucket + RLS | **YES** |
| File detail / preview | — | `missing` | P0 | route + signed-URL flow (Track H) | signed-URL only | **YES** |
| Imports | — | `missing` | P0 | route + Track G (preview/upsert/audit) | safe-import model | **YES** |
| Reports | — | `missing` | P0 | route + Track F (output comparison) | RLS-scoped | **YES** |
| Unmanaged accounts / UAR | — | `missing` | P0 | route + workflow + legacy comparison | RLS-scoped | **YES** |
| Stale users | — | `missing` | P0 | route + workflow + legacy comparison | RLS-scoped | **YES** |
| People / identity users | — (design-only; match-status slice) | `missing` | P0 | route + Track C + identity match model | RLS-scoped | **YES** |
| App users | roster inside `/apps/[id]` (read-only) | `partial` | P0 | route/list-parity + field parity | RLS read | **YES** |
| License rules | — (schema only) | `missing` | P0 | route + Track C + Track F | RLS-scoped | **YES** |
| License evaluations | — (schema only) | `missing` | P0 | route + report comparison | RLS-scoped | **YES** |
| Invoices / billing | — (schema only) | `missing` | P0 | route + Track M (billing parity) | RLS-scoped | **YES** |
| Audit logs (screen) | — (backend `audit_logs` + triggers exist; no UI) | `missing` | P0 | route + Track L | append-only, RLS read | **YES** |
| Admin / settings | — | `missing` | P0 | route + Track K | role-gated | **YES** |
| SSO / auth settings | — (email+password skeleton only) | `blocked-unknown-legacy-behavior` | P0 | confirm legacy SSO usage; then route + Track J/K | IdP model TBD | **YES** |
| Connectors | — (design only [19]) | `missing` | P0 | route + Track G + credential vault [19]/RISK-007 | encrypted vault, no service-role on request path | **YES** |
| Browser-extension workflows | — | `blocked-unknown-legacy-behavior` | P0 | confirm if legacy OMC used an extension; inventory first | TBD | **YES** |

### Track B — Workflow parity
| Legacy workflow | v3 equivalent | Status | Req? | Evidence | Sec model | Blocker |
|---|---|---|---|---|---|---|
| Create contract | `/contracts/new` | `partial` | P0 | workflow test + field parity | `0004` write | **YES** |
| Edit contract | `/contracts/[id]/edit` | `partial` | P0 | workflow test + field parity | `0004` write | **YES** |
| Link contract to app | app↔contract panels (read); link write? | `partial` | P0 | workflow test (link write path) | RLS + same-tenant FK `0006` | **YES** |
| Unlink contract from app | — | `missing` | P0 | workflow test; soft-unlink (no hard delete) | INSERT/UPDATE only, no `FOR ALL` | **YES** |
| Upload contract PDF | — (policies applied in staging, no app path) | `missing` | P0 | Track H + Storage REST verify (doc 26) | user-scoped upload, no service-role | **YES** |
| View / download contract file | — | `missing` | P0 | signed-URL flow + REST verify | signed-URL only, no public | **YES** |
| AI extract contract fields | — (design only [16]) | `missing` | P1 | Track I | suggestions-only | **YES** |
| Review AI suggestions | — | `missing` | P1 | Track I | no silent overwrite | **YES** |
| Approve / apply AI suggestions | — | `missing` | P1 | Track I + audit of accepted vs suggested | user-approved writes | **YES** |
| Reject AI suggestions | — | `missing` | P1 | Track I | audited | **YES** |
| Import app users | — | `missing` | P0 | Track G (preview/upsert/audit) | safe-import | **YES** |
| Sync SaaS app users | — | `missing` | P0 | Track G + connector | connector vault | **YES** |
| Detect unmanaged accounts | — | `missing` | P0 | workflow + legacy comparison | RLS-scoped | **YES** |
| Run license optimization | — | `missing` | P0 | workflow + report comparison | RLS-scoped | **YES** |
| Generate reports | — | `missing` | P0 | Track F | RLS-scoped | **YES** |
| Export CSV / PDF | — | `missing` | P0 | Track F (output comparison) | RLS-scoped export | **YES** |
| Schedule emailed reports | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy scheduling; then workflow | cron + RLS-scoped | **YES** |
| View audit history | — (backend only) | `missing` | P0 | Track L | append-only read | **YES** |
| Configure tenant/company settings | — | `missing` | P0 | Track K | role-gated | **YES** |
| Manage users / groups / roles | — (memberships exist in DB; no UI) | `missing` | P0 | Track K + RLS test | role-gated, no self-promote | **YES** |
| Connector setup / status check | — (design only) | `missing` | P0 | Track G | vault, health checks | **YES** |
| Billing / invoice workflow | — | `blocked-unknown-legacy-behavior` | P0 | Track M (confirm OMC billing mechanism) | TBD | **YES** |

### Track C — Field-level form parity
> **Rule: page parity is not form parity. Every OMC-used field must be present, mapped, `deprecated-approved`, or blocked.**

| Form | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Contract fields | create/edit forms (`0011` parity fields) | `partial` | P0 | field-by-field legacy comparison | gaps in [15] (commodity_*/validated/gantt); PDF/AI fields not built |
| App fields | app detail (read) | `partial` | P0 | field-by-field legacy comparison | write path missing |
| App-user fields | roster (read) | `partial` | P0 | field comparison | read-only |
| People / identity fields | — | `blocked-unknown-legacy-behavior` | P0 | inventory legacy identity fields | design-only |
| Invoice fields | — (schema only) | `missing` | P0 | field comparison vs legacy invoice | — |
| File metadata fields | `files` (`0012`) | `partial` | P0 | field comparison; surfaced UI missing | not surfaced |
| License rule fields | — (schema only) | `missing` | P0 | field comparison vs legacy rule builder | — |
| Report filter fields | — | `missing` | P0 | Track F | — |
| Admin / settings fields | — | `missing` | P0 | Track K | — |
| Connector config fields | — | `missing` | P0 | Track G | vault-stored secrets |
| SSO config fields | — | `blocked-unknown-legacy-behavior` | P0 | confirm legacy SSO | — |

### Track D — Table / list / filter / sort parity
For **each** list track: columns · default sort · search · filters · tabs · pagination · bulk actions · empty
states · status badges · row actions · CSV export · detail links · permission-specific visibility.

| List | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Apps list | `/apps` | `partial` | P0 | list-attribute checklist vs legacy | columns/sort/filters/export unverified |
| Contracts list | `/contracts` | `partial` | P0 | list-attribute checklist vs legacy | as above |
| Files list | — | `missing` | P0 | full list checklist | — |
| Users / app users list | roster (read) | `partial` | P0 | list checklist | embedded, not standalone |
| People / identity list | — | `missing` | P0 | list checklist | — |
| Unmanaged accounts list | — | `missing` | P0 | list checklist | — |
| Stale users list | — | `missing` | P0 | list checklist | — |
| License rules list | — | `missing` | P0 | list checklist | — |
| Invoices list | — | `missing` | P0 | list checklist | — |
| Reports list | — | `missing` | P0 | list checklist | — |
| Audit log list | — | `missing` | P0 | list checklist + Track L | — |

### Track E — Dashboard & metrics parity
| Metric | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| ELU / effective license utilization | — | `missing` | P0 | metric definition + legacy value comparison | depends on license eval |
| Wasted licenses | — | `missing` | P0 | metric + comparison | — |
| Unmanaged accounts | — | `missing` | P0 | metric + comparison | — |
| Orphaned accounts | — | `missing` | P0 | metric + comparison | — |
| Stale users | — | `missing` | P0 | metric + comparison | — |
| Contract renewal dates | partial (contract data exists) | `partial` | P0 | dashboard surface + comparison | no dashboard |
| Spend by app | — | `missing` | P0 | metric + comparison | needs invoices/spend |
| Spend by org | — | `missing` | P0 | metric + comparison | needs invoices/spend |
| Invoice allocation | — | `missing` | P0 | metric + comparison | Track M |
| Risk / criticality | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy definition | — |
| SaaS inventory counts | partial (apps exist) | `partial` | P0 | metric + comparison | — |
| Contract coverage metrics | — | `missing` | P0 | metric + comparison | — |
| App-user intelligence summary | partial (account-intelligence card) | `partial` | P1 | comparison vs legacy summary | read-only slice |

### Track F — Reporting & export parity
| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| CSV exports | — | `missing` | P0 | report output comparison vs legacy CSV | RLS-scoped |
| PDF exports | — | `missing` | P0 | output comparison | — |
| Scheduled reports | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy scheduling | — |
| Emailed reports | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy email | — |
| Cost snapshot reports | — | `missing` | P0 | output comparison | — |
| License optimization reports | — | `missing` | P0 | output comparison | — |
| Unmanaged account reports | — | `missing` | P0 | output comparison | — |
| Contract reports | — | `missing` | P0 | output comparison | — |
| Invoice / spend reports | — | `missing` | P0 | output comparison | Track M |
| Audit reports | — | `missing` | P0 | output comparison + Track L | — |
| Report filters | — | `missing` | P0 | filter parity vs legacy | — |
| Report permissions | — | `missing` | P0 | RLS/security test per report | no cross-tenant leakage |

### Track G — Import & connector parity
> **Rule: do NOT copy unsafe legacy blind-delete import behavior. Replacement model must use preview, upsert,
> soft-delete/deactivation, audit, and rollback.**

| Item | v3 equivalent | Status | Req? | Evidence | Sec model |
|---|---|---|---|---|---|
| CSV imports | — | `blocked-security` | P0 | preview→upsert→audit→rollback workflow test | safe-import (no blind delete) |
| Email / file inbound imports | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy inbound | — |
| SaaS app connectors | — (design [19]) | `missing` | P0 | connector + vault [19]/RISK-007 | encrypted vault, isolated job |
| SCIM | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy SCIM | — |
| Identity provider sync | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy IdP sync | — |
| Slack / admin connectors | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy use | — |
| Browser-extension data | — | `blocked-unknown-legacy-behavior` | P0 | confirm legacy extension | — |
| App-user import / update flows | — | `blocked-security` | P0 | safe-import workflow test | upsert + soft-deactivate |
| Invoice imports | — | `missing` | P0 | safe-import + Track M | — |
| Contract file imports | — (Storage policies applied, no path) | `missing` | P0 | Track H | user-scoped |
| Connector health / status | — | `missing` | P0 | status checks | — |
| Connector error handling | — | `missing` | P0 | error workflow test | — |
| Connector credential storage | — (design [19]) | `blocked-security` | P0 | vault implemented + tested ([19], RISK-007) | encrypted, never service-role on request path |

### Track H — File & Storage parity (current state recorded accurately)
**Known staging state:** bucket `contract-files` exists; `public=false`; Storage object policies **structurally
applied** (INSERT/SELECT, `authenticated`); **unsafe policy count = 0**; helper functions `can_write_contract_file`
/ `can_read_contract_file` exist (`0014`); **RISK-001 remains OPEN**; **real Storage REST API auth matrix is
PENDING** (verifier built [26], not yet run); **no upload route/action/UI, no signed-URL route, no AI extraction**
in the current branch.

| Item | v3 equivalent | Status | Req? | Evidence | Sec model |
|---|---|---|---|---|---|
| Upload UI | — | `missing` | P0 | route + UI evidence | user-scoped |
| Server-side upload action | — | `missing` | P0 | workflow test | user-scoped client, no service-role |
| File metadata creation | `files` `0012`/`0013` | `partial` | P0 | RLS test (222) + surfaced path | source of truth |
| User-scoped Storage upload | policy applied (staging) | `partial` | P0 | **doc 26 REST verify (pending)** | INSERT policy + files-row gate |
| Download / view flow | — | `missing` | P0 | signed-URL route + REST verify | signed-URL only |
| Short-lived signed-URL flow | — | `missing` | P0 | REST verify (single-object, TTL) | per-object, post-authz |
| Delete / replace policy decision | no UPDATE/DELETE policy (by design) | `deprecated-approved` (pending signoff) | P1 | record the no-overwrite/no-delete decision + OMC signoff | no `FOR ALL` |
| File audit trail | — | `missing` | P0 | Track L | append-only |
| Cross-tenant denial verification | policy applied | `partial` | P0 | **doc 26 REST verify (pending)** | RLS + path-tenant binding |
| Anonymous denial verification | policy applied | `partial` | P0 | **doc 26 REST verify (pending)** | private bucket, no anon policy |

### Track I — AI extraction parity
> **Rule: AI suggestions only. No silent overwrite.**

| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Upload PDF | — | `missing` | P1 | Track H | gated by Storage verify |
| Extract fields | — (design [16]) | `missing` | P1 | workflow test | untrusted text |
| Show extracted suggestions | — | `missing` | P1 | UI evidence | suggestions only |
| Review suggestions | — | `missing` | P1 | UI evidence | human in loop |
| Apply selected suggestions | — | `missing` | P1 | workflow + audit | user-approved write |
| Reject suggestions | — | `missing` | P1 | workflow + audit | — |
| Track extraction status | `files.extraction_status` (`0012`) | `partial` | P1 | surfaced UI | column exists, not surfaced |
| Track extraction errors | `files.extraction_error` (`0012`) | `partial` | P1 | surfaced UI | column exists, not surfaced |
| Audit AI suggested vs accepted | — | `missing` | P1 | Track L diff | no silent overwrite |
| Prevent silent overwrite | — | `missing` | P1 | workflow test | review-and-apply only |
| Prompt-injection guardrails | — | `missing` | P1 | security test | strict allowlist parse |
| Provider failure handling | — | `missing` | P1 | error workflow test | graceful degrade |

### Track J — Auth / role / permission / tenant-switching parity
| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Login | email+password skeleton | `partial` | P0 | workflow test + hosted auth | not hosted-exercised |
| Logout | logout route handler | `partial` | P0 | workflow test | — |
| Session persistence | `@supabase/ssr` cookie session | `partial` | P0 | workflow test (hosted) | — |
| Tenant context | resolver (`src/lib/auth/tenant-context`) | `partial` | P0 | RLS test | read-only resolve |
| Role-based navigation | — | `missing` | P0 | UI evidence per role | — |
| Tenant-member permissions | RLS (`0001`–`0014`) | `partial` | P0 | RLS test (222) | enforced; UI partial |
| Org-manager permissions | RLS (`0002`/`0004`) | `partial` | P0 | RLS test | enforced |
| Owner/admin/editor behavior | RLS | `partial` | P0 | RLS test + UI | write UI partial |
| Viewer behavior | RLS | `partial` | P0 | RLS test + UI | read-only |
| Procurement-org manager behavior | RLS (`0004`) | `partial` | P0 | RLS test (T34/T35) | enforced |
| Paying-org manager behavior | RLS (`0004`, never write) | `partial` | P0 | RLS test (T34/T35) | enforced (no write) |
| Tenant switching | — | `blocked-unknown-legacy-behavior` | P0 | confirm if legacy had multi-tenant switching | — |
| SSO / SAML / OIDC | — | `blocked-unknown-legacy-behavior` | P0 | confirm OMC IdP usage | — |
| Password reset / invite flow | — | `blocked-unknown-legacy-behavior` | P0 | confirm legacy flow | — |

### Track K — Admin & settings parity
| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Company profile | — | `missing` | P0 | route + field parity | — |
| Domains | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy domain mgmt | — |
| Allowed users | — | `missing` | P0 | route + RLS test | — |
| Team / user management | memberships in DB; no UI | `missing` | P0 | route + RLS test | no self-promote |
| Groups | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy groups | — |
| Roles | RLS roles exist; no UI | `partial` | P0 | route + RLS test | enforced in DB |
| API keys | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy API keys | vault if any |
| Connector settings | — | `missing` | P0 | Track G | — |
| Billing settings | — | `blocked-unknown-legacy-behavior` | P0 | Track M | — |
| SSO settings | — | `blocked-unknown-legacy-behavior` | P0 | confirm OMC SSO | — |
| Report schedule settings | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy scheduling | — |
| Recompute / reprocess admin tools | — | `blocked-unknown-legacy-behavior` | P1 | confirm legacy tools | isolated jobs |

### Track L — Audit / logging parity
> **Rule: do NOT copy unsafe legacy 90-day purge unless explicitly `deprecated-approved`. User-facing audit
> visibility still needs parity.**

| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Audit log screen | — (backend `audit_logs` append-only) | `missing` | P0 | route + UI evidence | backend exists, no UI |
| Before/after diff viewer | — | `missing` | P0 | UI evidence | contract audit-on-write `0010` |
| Actor filter | — | `missing` | P0 | UI evidence | — |
| Date filter | — | `missing` | P0 | UI evidence | — |
| Object filter | — | `missing` | P0 | UI evidence | — |
| Export audit logs | — | `missing` | P1 | Track F | — |
| Contract change history | `0010` audit-on-write (backend) | `partial` | P0 | surfaced UI | recorded, not surfaced |
| File upload/download history | — | `missing` | P0 | Track H audit | — |
| AI suggestion/apply history | — | `missing` | P1 | Track I audit | — |
| Admin action history | — | `missing` | P0 | UI evidence | — |

### Track M — Billing & revenue parity
> **Rule: if old OMC drives the current paying-customer billing mechanism, v3 cannot replace it without this
> track being `complete`.**

| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Current billing calculation | — | `blocked-unknown-legacy-behavior` | P0 | confirm OMC billing mechanism first | — |
| Monthly billing cron | — | `blocked-unknown-legacy-behavior` | P0 | confirm legacy cron | isolated job |
| Invoice generation | — (invoices schema only) | `missing` | P0 | workflow + reconciliation | — |
| Usage / count basis | — | `blocked-unknown-legacy-behavior` | P0 | confirm legacy basis | — |
| Customer billing records | — | `blocked-data-migration` | P0 | Track N + reconciliation | — |
| Chargeback / allocation | — | `missing` | P0 | workflow + report comparison | — |
| Spend reporting | — | `missing` | P0 | Track F | — |
| Admin billing view | — | `missing` | P0 | route + UI | role-gated |
| Failure / retry behavior | — | `missing` | P0 | error workflow test | — |
| Reconciliation against OMC billing | — | `blocked-data-migration` | P0 | before/after billing reconciliation + OMC signoff | **cutover-critical** |

### Track N — Data migration parity
Required evidence for **each** entity: **row counts · sample record validation · cross-tenant isolation
validation · (files) file byte validation · before/after report comparison · rollback plan · OMC signoff.**

| Entity | Status | Req? | Evidence | Notes |
|---|---|---|---|---|
| Tenants | `blocked-data-migration` | P0 | row counts + reconciliation + signoff | — |
| Orgs | `blocked-data-migration` | P0 | as above | — |
| Memberships | `blocked-data-migration` | P0 | + cross-tenant isolation | — |
| Apps | `blocked-data-migration` | P0 | as above | — |
| Contracts | `blocked-data-migration` | P0 | as above | — |
| Contract–app links | `blocked-data-migration` | P0 | + same-tenant integrity | — |
| App users | `blocked-data-migration` | P0 | as above | — |
| People | `blocked-data-migration` | P0 | as above | — |
| Identity users / accounts | `blocked-data-migration` | P0 | + identity match validation | — |
| Identity matches | `blocked-data-migration` | P0 | as above | — |
| Files metadata | `blocked-data-migration` | P0 | row counts + sample | — |
| Actual file bytes | `blocked-data-migration` | P0 | **file byte validation** + Track H | hosted Storage |
| Invoices | `blocked-data-migration` | P0 | + reconciliation | Track M |
| Billing records | `blocked-data-migration` | P0 | + billing reconciliation + signoff | cutover-critical |
| License rules | `blocked-data-migration` | P0 | row counts + sample | — |
| License evaluations | `blocked-data-migration` | P0 | + report comparison | — |
| Reports | `blocked-unknown-legacy-behavior` | P1 | confirm if legacy reports persist | — |
| Scheduled reports | `blocked-unknown-legacy-behavior` | P1 | confirm legacy schedules | — |
| Audit history | `blocked-data-migration` | P0 | row counts + retention decision (Track L) | no unsafe purge |
| Connector configs | `blocked-security` | P0 | vault [19]; no plaintext secrets | — |
| User roles | `blocked-data-migration` | P0 | + RLS isolation validation | — |
| Settings | `blocked-data-migration` | P0 | reconciliation | Track K |

### Track O — UX / navigation parity
> **Rule: backend parity is not UX parity. OMC users must still be able to do the job without losing known workflows.**

| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Main nav | partial (apps/contracts) | `partial` | P0 | UI evidence vs legacy | most areas absent |
| Sidebar / header | partial | `partial` | P1 | UI evidence | — |
| Breadcrumbs | `blocked-unknown-legacy-behavior` | P2 | confirm legacy | — |
| Detail page layout | partial | `partial` | P1 | UI comparison | — |
| Edit flows | partial (contracts) | `partial` | P0 | UI comparison | — |
| Save / cancel behavior | partial | `partial` | P1 | UI evidence | — |
| Loading states | `missing` | P2 | UI evidence | — |
| Error messages | partial | `partial` | P1 | UI evidence | — |
| Empty states | partial | `partial` | P1 | UI evidence | — |
| Confirmation modals | `missing` | P1 | UI evidence | — |
| Button names | `blocked-unknown-legacy-behavior` | P1 | legacy label comparison | — |
| Status labels | `blocked-unknown-legacy-behavior` | P1 | legacy comparison | — |
| Field grouping | `blocked-unknown-legacy-behavior` | P1 | legacy comparison | — |

### Track P — Operational parity
| Item | v3 equivalent | Status | Req? | Evidence | Notes |
|---|---|---|---|---|---|
| Staging environment | staging project + env inventory [24] | `partial` | P0 | env wiring evidence | exists |
| Staging dataset | synthetic fixtures (doc 26) | `partial` | P0 | OMC-shaped dataset | partial |
| Vercel env wiring | [24] inventory | `partial` | P0 | wiring evidence | per-env |
| Hosted Supabase migrations | `0001`–`0014` staged | `partial` | P0 | migration list (staging) | done staging, not prod |
| Storage policy verification | structural applied; REST **pending** | `partial` | P0 | **doc 26 REST verify (pending)** | RISK-001 OPEN |
| Backup / restore | `missing` | P0 | rehearsal evidence | — |
| Rollback | runbook discipline [20] | `partial` | P0 | rehearsed rollback | documented |
| Monitoring | `blocked-unknown-legacy-behavior` | P1 | confirm needs | — |
| Error logging | `blocked-unknown-legacy-behavior` | P1 | confirm needs | no PII in telemetry (RISK-013) |
| Migration rehearsal | `missing` | P0 | dry-run evidence | Track N |
| OMC signoff | `missing` | P0 | recorded signoff | gate [17 §5] |
| Production apply runbook | [20]/[22] (staging-only so far) | `partial` | P0 | prod runbook + approval | not run |
| Post-cutover smoke tests | `missing` | P0 | smoke test plan + run | — |

---

## Current replacement readiness assessment

- **v3 is stronger technically than the old app in several backend/security areas** (RLS-as-authorization,
  append-only audit, no service-role on request paths, forward-only migrations, contract-write authority model).
- **v3 is NOT OMC replacement-ready.**
- **OMC replacement readiness is still mostly ahead** — full legacy parity has **not** been mapped and closed;
  most rows above are `missing` or `blocked-unknown-legacy-behavior`.

**Completed / partial areas (none are full-parity `complete`):**
- Apps read/detail — `partial`
- Contracts read/create/edit — `partial`
- Contract form parity — `partial` (gaps in [15])
- Files metadata / RLS foundation — `partial`
- Storage structural staging apply — `partial` (REST verify pending)
- Storage REST verification — **pending** (verifier [26] not yet run)
- OMC parity gate docs — created ([17])
- OMC confirmation pass scaffolding — created ([18])
- Connector credential vault design — created ([19])
- Hosted apply discipline — created ([20])

**Major unknown / missing areas (each a blocker):**
- full route inventory · reports/exports · imports/connectors · UAR/unmanaged/stale users · billing/revenue ·
  admin/settings · data migration · audit viewer · AI extraction implementation ·
  file upload/download/signed-URL implementation.

---

## How this matrix controls future PRs

- **Future feature PRs MUST reference the matrix row(s) they close** (by track + legacy area).
- **A PR cannot claim OMC parity without evidence** recorded in this doc or a linked evidence doc (route exists
  + workflow/RLS test + reviewer initials; not executor claim alone).
- **A missing/unknown legacy behavior is a blocker** until inventoried (`blocked-unknown-legacy-behavior` →
  inventoried → `partial`/`complete` or `deprecated-approved`).
- **Security-improved replacement is allowed**, but the **user-facing parity must still be mapped** (a safer
  model does not waive the behavior row).
- **Deprecated legacy behavior requires explicit approval** (owner + OMC signoff) — never a developer assumption.
- **"Better than legacy" does not mean "parity complete"** unless the OMC-required behavior still exists.
- This matrix **does not close RISK-001 and does not authorize cutover** — [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
  go/no-go + the broader hosted-apply criteria ([20 §9](./20_STAGING_HOSTED_APPLY_AND_CUTOVER_DISCIPLINE.md)) still gate cutover.

## Risk posture

**RISK-001** (no full hosted apply/verification), **RISK-002** (`files`/reads not surfaced), **RISK-007** (no
credential vault), **RISK-016** all remain **OPEN**. Cutover stays **BLOCKED** ([17] is binding). OMC/Flywheel
is a paying production **replacement, not a pilot**.
