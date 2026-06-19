# 39 · Old-App Direct Inspection Inventory

**Purpose:** turn the audited docs ([27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) / [37](./37_EXISTING_PARITY_DOCS_AUDIT.md)
/ [38](./38_OMC_FULL_PARITY_SCOPE_DECISION.md)) into a concrete, page-by-page / workflow-by-workflow /
integration-by-integration **inspection packet** for the live old app — the input to the full-parity build
backlog. **This PR prepares direct old-app inspection; it does not complete old-app inspection.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **Inspection packet PREPARED — direct old-app inspection STILL REQUIRED.** The old app is **not present in
>   this repo** (it is a separate `frontend-v2/` Firebase app); nothing here was inspected live. Every
>   live-capture field below is **TBD — capture during direct inspection**.
> - **OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability.** **The
>   MVP subset framing is not sufficient for OMC cutover.**
> - **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.**
> - **Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**
> - **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage
>   completion is necessary but not sufficient for cutover.** No doc 17 §5 box ticked; no feature built.

---

## 1. How to use this packet

For **each** category in §4: open the named old-app screen as each persona (§6), and fill the **14-field capture
template (§3)** — screenshots + field names + button labels + import/export formats + AI/connector behavior
(§5), without capturing secrets. Record gaps in the **gap ledger (§7)**; that ledger becomes the build backlog.
Legacy page names below are seeded from [`current-product-map.md`](./current-product-map.md) (an evidence-based
extraction of the legacy `frontend-v2/` routes); **confirm them live** — the map is not a substitute for
inspection.

---

## 2. Personas (capture each screen as each relevant role)

Admin/owner · Tenant manager/editor · Procurement-org manager · Read-only/viewer · (and any OMC-specific role
surfaced during inspection). Roles/tenant boundaries must be captured per screen — they drive the v3 RLS model.

---

## 3. Per-screen capture template (fill once per screen × persona)

| Field | What to record |
|---|---|
| **Old app URL/page/screen** | exact route + screen title |
| **User role/persona** | which role this capture is for |
| **What the user can see** | sections, widgets, columns, counts |
| **Create/edit/delete/export/import** | every write/action available |
| **Filters/search/sort** | every filter, search box, sort, saved view |
| **Empty/loading/error states** | what renders with no data / while loading / on error |
| **Permissions & tenant-boundary expectations** | what this role can/can't see; cross-tenant/cross-org rules |
| **Data shown** | fields/columns + their meaning + source collection |
| **AI/API behavior (if any)** | AI prompt/output, API call, sync, computed field |
| **Current v3 equivalent** | the v3 route/DAL (or "none") |
| **Current v3 status** | Complete / Partial / Missing / Unknown |
| **Cutover blocker** | Yes / No (default **Yes** unless OMC-waived — doc 38 §5) |
| **Evidence/source** | screenshot ref + doc/source; **no secrets** |
| **Required PR bucket** | which build bucket closes it (§7) |

---

## 4. Inventory — every full-parity category (legacy page seeded; live fields = TBD)

v3 status from [37 §5](./37_EXISTING_PARITY_DOCS_AUDIT.md)/[38 §6](./38_OMC_FULL_PARITY_SCOPE_DECISION.md).
"Capture" = fill §3 live. **Default cutover-blocker = Yes** unless OMC waives in writing (doc 38 §5).

| # | Category | Legacy page (confirm live) | v3 equivalent | v3 status | Blocker | PR bucket |
|---|---|---|---|---|---|---|
| 1 | UI shell / navigation | `(authenticated)/layout.tsx` + `AuthGuard` | auth shell | Partial | Yes | Shell/UX |
| 2 | Dashboard / home | `(authenticated)/page.tsx` (metric cards) | none | Missing | Yes | Dashboard |
| 3 | Apps inventory | `IDCApps/page.tsx` (cost/util/user metrics) | `/apps` (read) | Partial | Yes | Apps |
| 4 | App detail | `IDCApps/[id]/page.tsx` (roster/invoices/compliance/linked) | `/apps/[id]` (read) | Partial | Yes | Apps |
| 5 | App users | `IDCApps/[id]` roster | app-users roster (read) | Partial | Yes | Apps/People |
| 6 | Identity users / employees | `people/page.tsx` (IdP + app-only) | none (schema only) | Missing | Yes | People/Identity |
| 7 | App-user identity matching | `people/settings` (matching rules) + match status | match-status read (`0008`) | Partial | Yes | People/Identity |
| 8 | Contracts list | `contracts/page.tsx` | `/contracts` (read) | Partial | Yes | Contracts |
| 9 | Contract detail | `contracts/[id]` | `/contracts/[id]` (read) | Partial | Yes | Contracts |
| 10 | Contract create/edit | `contracts/create` (+ edit) | `/contracts/new`,`/[id]/edit` | Partial (fields) | Yes | Contracts |
| 11 | Contract steward / write workflow | contract write + authority | `0004` authority + `0010` audit | Complete (core) | Yes | Contracts |
| 12 | Contract-file relationship | contract ↔ document links | schema only (not surfaced) | Missing | Yes | Files |
| 13 | File upload / download | `files/page.tsx`,`[fileId]` (AI status) | bucket+policies (no UI) | Missing (surface) | Yes | Files |
| 14 | Spend / license / account intelligence | `IDCApps/[id]/invoices`, `insights/elu` | account-intel read only | Partial/Missing | Yes | License/Spend |
| 15 | Shadow IT / unmanaged accounts | `IDCApps/insights/uar`, `people/risks` | none | Missing | Yes | People/UAR |
| 16 | SaaS license optimization | `IDCApps/insights/elu` (waste) | none | Missing | Yes | License/Spend |
| 17 | Imports | CSV ingest / `api/v1/ingest` | none | Missing | Yes | Imports/Export |
| 18 | Exports | export/report downloads | none | Missing | Yes | Imports/Export |
| 19 | Reporting | scheduled/emailed reports | none | Missing | Yes | Reporting |
| 20 | AI contract analysis | `contracts/create` PDF AI | designed (doc 16), not built | Missing | Yes | AI |
| 21 | AI app / license intelligence | `insights/*`, invoice AI | none | Missing | Yes | AI |
| 22 | API / SaaS connectors | `IDCApps/scraping`, `automatedScrapingService` (53 scrapers) | none (doc 19 design) | Missing | Yes | Connectors |
| 23 | Connector token storage / security | connector auth/token store | none (vault not built, RISK-007) | Missing | Yes | Connectors/Vault |
| 24 | Connector ingestion / audit logs | `files/inbound`, ingest CRONs | none | Missing | Yes | Connectors |
| 25 | Admin / settings | `admin/company`,`admin/recompute`,`IDCApps/settings`,`people/settings` | none | Missing | Yes | Admin |
| 26 | Audit / history | `logging/page.tsx`,`[logId]` (before/after diff) | `audit_logs`+`0010`, no viewer | Partial | Yes | Admin/Audit |
| 27 | Roles / permissions | `company/users`, `profile` | RLS + memberships (no admin UI) | Partial | Yes | Admin/Auth |
| 28 | Legacy OMC data migration | Firestore → v3 (doc 34) | planned, not run | Missing | Yes | Migration |
| 29 | Rollback / recovery | cutover rollback (doc 35) | planned, not rehearsed | Missing | Yes | Rollback |
| 30 | OMC acceptance / signoff | acceptance (doc 36) | planned, not recorded | Missing | Yes | Acceptance |

*(Also confirm live: contract **gantt/timeline**, **invoices** detail + chargeback/billing, **stale users**,
**profile/own-account**, **Chrome extension**, **SSO/SCIM** — capture or OMC-waive each.)*

---

## 5. Capture instructions

For each screen/persona:
- **Screenshots** of each old-app screen (every state — populated, empty, loading, error).
- **Field names + table columns** (exact labels + meaning + source collection).
- **Button labels / actions** (every create/edit/delete/export/import/sync control).
- **Import/export formats** (file types, headers/columns, sample shape — **no real customer rows**).
- **AI prompts/outputs if exposed** (the prompt, the output schema, where applied — suggestions vs auto-apply).
- **Connector list, auth model, and token/security expectations** (which connectors, OAuth vs API-key, where
  tokens live, rotation — **descriptions only, never the tokens**).
- **Role-specific differences** (re-capture each screen per persona; note what each role can/can't see/do).

**Do NOT capture:** secrets, tokens, API keys, JWTs, cookies, real credentials, or customer-confidential exports
(real PII / real spend / real contracts). Capture **shapes and labels**, not real data. This packet and any
filled copy must contain **no secrets and no real customer data**.

---

## 6. OMC interview script (walk the live old app together)

Per surface, ask OMC (record answers into §3/§7):
1. **"Show me how you do this today."** — walk the real workflow start→finish; screenshot each step.
2. **"Who does this, and what can each role see/do?"** — personas + tenant/org boundaries.
3. **"What do you filter/search/sort by, and which saved views matter?"**
4. **"What must be exported/imported, in what format, and how often?"**
5. **"Where does AI help, and do you trust it to auto-apply or only suggest?"**
6. **"Which connectors/integrations are live, and which are essential vs nice-to-have?"**
7. **"What here do you NOT use?"** — candidates for an explicit written **waiver** (doc 38 §5; recorded as
   `removed-approved`/`deprecated-approved`/`not-used-by-OMC` in doc 27 with OMC signoff). Silence ≠ waiver.
8. **"What would block you from switching off the old app on day one?"** — the hard cutover blockers.

---

## 7. Full-parity gap ledger (becomes the build backlog after inspection)

Fill one row per confirmed gap during inspection; this is the backlog. **Default status = blocker** until built +
verified or OMC-waived. (Seeded from §4 with known gaps; every "OMC-waived?" starts **No** until written signoff.)

| Category | Gap (what legacy does that v3 lacks) | Required PR bucket | Priority (P0/P1/P2) | OMC-waived? (written) | doc 27 row |
|---|---|---|---|---|---|
| _capture_ | _e.g. file upload + signed-URL download UI_ | Files | P0 | No | H-row |
| _capture_ | _e.g. people directory + UAR_ | People/UAR | P0 | No | A/E-row |
| _capture_ | _e.g. imports (non-destructive upsert+preview)_ | Imports/Export | P0 | No | G-row |
| _capture_ | _e.g. AI contract extraction (suggestions-only)_ | AI | P1 | No | I-row |
| _capture_ | _e.g. connector vault + connectors_ | Connectors/Vault | P0/P1 | No | G-row |
| … | _one row per gap found in §4_ | … | … | No | … |

Every ledger row must end as **built + verified** or **OMC-waived in writing** before its doc 17 §5 box can be
true.

---

## 8. Cannot answer from repo alone (requires the live old app / OMC)

The repo **cannot** supply, and direct inspection MUST capture:
- The actual rendered screens, exact field labels, button text, and per-role differences (the repo has a route
  map, not the live UI).
- Empty/loading/error-state behavior and validation rules.
- Real filter/search/sort options and saved views.
- Exact import/export **formats** (columns/headers) and report layouts.
- The real AI prompts/outputs and whether AI auto-applies or only suggests.
- The live connector list, each connector's auth model, and token/rotation expectations.
- Which capabilities OMC actually uses vs would **waive** (doc 18 confirmation pass + doc 38 §5).
- Performance/SLO expectations for the critical flows.

Until these are captured live, **old-app replacement is not yet verified** and the build backlog (§7) is not
finalized.

---

## 9. Risk posture

**This PR prepares direct old-app inspection; it does not complete old-app inspection.** It builds no feature,
inspects nothing live, and changes no risk disposition. **OMC requires full old-app parity before cutover unless
OMC explicitly waives a specific capability. The MVP subset framing is not sufficient for OMC cutover. Old-app
parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete. RISK-001 remains
OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage completion is necessary but
not sufficient for cutover. Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**
No production/staging mutation, no hosted command, no secrets. OMC/Flywheel is a paying production **replacement,
not a pilot**.
