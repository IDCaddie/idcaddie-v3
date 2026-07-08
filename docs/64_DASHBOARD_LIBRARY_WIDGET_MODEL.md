# 64 — Dashboard Library / Widget Model (D-001, design-only)

> **CURRENT CURSOR (2026-07-08):** `idcaddie-v3` main @ `c39c20a` (PRs through **#288**); `idcaddie-connector-runner`
> main @ `84ecf6d` (untouched). Governance unchanged: **RISK-007 remains OPEN; Phase C remains BLOCKED; connector live
> data-sync has not run; production untouched.**
>
> **THIS IS A DESIGN DOCUMENT ONLY.** No schema, tables, widgets, dashboard writes, migrations, or UI exist or are
> created by this PR. Everything below labelled a "table", "field", "widget", or "phase" is a **proposal** for later
> review, not a shipped artifact. Old-app parity is **NOT** complete.

**Purpose.** Design the future dashboard **library + widget model** — the old ID Caddie dashboard product shape rebuilt
safely on v3's RLS-first architecture.

---

## 1. Executive summary

**Required thesis:** *Old ID Caddie proves the dashboard product shape — a dashboard library, saved dashboards, widget
counts, quick-start templates, and a create/edit flow. v3 should rebuild that capability only after a proper
tenant-scoped RLS design; do not add dashboard writes casually.*

Today v3 ships a **single static `/dashboards`** (fixed KPI cards + dependency-free spend/renewal charts) plus a
`/reports` summary. That's safe but not the product: the old app let operators **save** governance dashboards, pick
**widgets**, and start from **templates**. A dashboard library turns v3 from "one report page" into a cockpit each
tenant composes for itself.

**Why design must precede schema/writes:** a dashboard builder is the first feature that **persists user-authored
config** and **runs user-chosen queries** — the two highest-risk surfaces in the whole app. Done casually it becomes a
raw report builder that bypasses RLS or leaks cross-tenant data. So the model (tables, RLS, widget catalog, config
safety) must be reviewed **before** any migration or write ships. This doc is that model; it changes nothing.

---

## 2. Old app evidence (from screenshots)

The old app's dashboard product (screenshot-evidenced; see [62_OLD_UI_PRODUCT_PARITY_AUDIT.md](./62_OLD_UI_PRODUCT_PARITY_AUDIT.md)):

- A **dashboard library** page listing multiple dashboards.
- **Saved dashboard cards** (each a named, reusable dashboard).
- **Widget counts** per card ("N widgets").
- A **New Dashboard** action.
- **Quick-start / template** dashboards to start from.
- A **create dashboard** page with: a **name** field, a **description** field, a **widget area/canvas**, an
  **add-widget** action, and a **save** action.

*(Product evidence only. The old implementation — client-side Firestore, broad rules — is **not** a pattern to copy;
see [60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md) and §8 below.)*

---

## 3. Current v3 state

- **Static `/dashboards`** — fixed KPI cards (apps/contracts/files/accounts/audit) + dependency-free spend + renewal
  charts (contract data only). One page, not composable.
- **`/reports`** — visible-to-you summary count cards, deep-linked.
- **Design system exists** — `StatCard`/`StatGrid`, dependency-free charts (`SpendBars`/`RenewalSegmentBar`/
  `UpcomingRenewalRows`), `MatchRateMeter`, badges, skeletons — the widget-rendering primitives a library would reuse.
- **No saved dashboard library.** **No widget persistence.** **No dashboard builder / writes.** Nothing user-authored
  is stored.

---

## 4. Product goals

- Let users **save governance dashboards** (named, reusable) instead of one fixed page.
- Support **executive dashboards** (high-level KPIs) and focused **app / spend / renewal / people-risk** dashboards.
- Support **tenant- and org-scoped views** (the right audience sees the right cut).
- Support **reusable widgets** (one widget type, many placements/configs).
- Keep **visibility safe** — private / tenant / org / role-scoped, enforced by RLS.
- **Avoid public / unauthenticated report bypasses** entirely (a top old-app risk).

---

## 5. Domain definitions

- **Dashboard** — a saved collection of widgets + layout (tenant/org-scoped).
- **Widget** — a reusable visualization or table module placed on a dashboard.
- **Widget definition** — a *system-known* widget type (code-defined catalog entry; not user-authored).
- **Widget instance** — a dashboard-specific placement + safe configuration of a widget definition.
- **Dashboard template** — a predefined starter dashboard (a set of widget instances).
- **Saved filter** — a constrained, safe widget filter config (enums / preset ranges / RLS-visible ids only).
- **Visibility** — who may see a dashboard: private (creator) / tenant / org / role-scoped.

---

## 6. Proposed future tables

**Proposal only — none exist.** Each would ship migration-first (RLS enabled + **default-deny** until a reviewed policy)
with an RLS test matrix (§15) before any read/write. All carry `tenant_id` + owner/org columns; authorization is
**Postgres RLS**, never app/client filtering; no service-role on any request path; owner/user ids exposed as
booleans/names only.

### `dashboards`
- **Purpose:** a saved dashboard (name, description, owner, visibility, layout metadata).
- **Key fields (proposed):** `id`, `tenant_id`, `owning_org_id?`, `created_by`, `name`, `description`, `visibility`
  (private|tenant|org|role), `role_scope?`, `layout` (safe structured JSON of instance ids + positions — no queries),
  `is_archived`, timestamps.
- **RLS:** read/write gated by tenant membership **and** the visibility rule (private→creator; org→org members;
  role→role holders). **Sensitive:** `created_by` → boolean/name in DTOs, never raw id.
- **UI:** a future `/dashboards` library + a saved-dashboard view.

### `dashboard_widgets` (widget instances)
- **Purpose:** one placed, configured widget on a dashboard.
- **Key fields:** `id`, `tenant_id`, `dashboard_id`, `widget_definition_key` (FK to the code catalog), `title_override?`,
  `config` (safe structured config only — §9), `position`, timestamps.
- **RLS:** inherits the parent dashboard's tenant + visibility. **Sensitive:** none stored; `config` holds only
  allowlisted enums / preset ranges / RLS-visible ids.
- **UI:** the dashboard view + builder.

### `dashboard_widget_definitions` (catalog)
- **Purpose:** the system-known widget types (§7). **Code-defined first** (see Open Questions); if later DB-backed, it
  is admin-curated reference data, never user-authored.
- **Key fields:** `key`, `title`, `data_source` (which safe DAL/view backs it), `supported_config` (allowed operators/
  filters), `requires` (e.g. `spend_intelligence` for M-001-dependent widgets), `status`.
- **RLS:** read-only reference; not tenant-writable. **Sensitive:** none.
- **UI:** the "add widget" catalog picker.

### `dashboard_templates`
- **Purpose:** predefined starter dashboards (§11).
- **Key fields:** `key`, `title`, `description`, `intended_audience`, `requires`, `status` (available|gated).
- **RLS:** read-only reference. **Sensitive:** none.
- **UI:** the "New dashboard from template" / quick-start picker.

### `dashboard_template_widgets`
- **Purpose:** the widget instances a template seeds when instantiated.
- **Key fields:** `template_key`, `widget_definition_key`, `default_config` (safe), `position`.
- **RLS:** read-only reference. **Sensitive:** none.
- **UI:** template preview + instantiation.

### `dashboard_saved_filters`
- **Purpose:** reusable, constrained filter configs a widget can reference.
- **Key fields:** `id`, `tenant_id`, `created_by`, `name`, `filter` (allowlisted enum/date-preset/RLS-visible-id only —
  §9), timestamps.
- **RLS:** tenant-member read; write audited. **Sensitive:** referenced org/app ids must be re-checked against the
  caller's RLS-visible set at render (a saved filter can't grant access to a now-inaccessible org).
- **UI:** widget config panel.

### `dashboard_visibility_rules` (a.k.a. `dashboard_shares`)
- **Purpose:** explicit visibility grants beyond the base `visibility` field (e.g. share with a specific org/role).
- **Key fields:** `id`, `tenant_id`, `dashboard_id`, `grant_type` (org|role), `grant_ref`, `created_by`, timestamps.
- **RLS:** tenant-scoped; grants can only widen **within the tenant** — **never cross-tenant, never public**. **Sensitive:**
  `created_by` → boolean/name.
- **UI:** a future (separately-designed) share panel — **not** in the first build (D-009).

### `dashboard_audit_events`
- **Purpose:** append-only record of dashboard create/edit/share/delete (governance trail).
- **Key fields:** `id`, `tenant_id`, `dashboard_id`, `action`, `actor_recorded` (bool), `occurred_at`, `detail_safe`.
- **RLS:** tenant-member read; append-only (mirrors the existing audit trigger pattern). **Sensitive:** no actor id/IP/
  raw diff — safe structured detail only.
- **UI:** dashboard history; feeds `/audit`.

---

## 7. Widget catalog design

Initial safe widget types. "Now?" = can a v3 widget be powered by **existing** RLS-scoped data today (in a future
library); "needs M-001" = requires the gated spend-intelligence data ([63_SPEND_INTELLIGENCE_MODEL.md](./63_SPEND_INTELLIGENCE_MODEL.md)).

| Widget | Data source (existing safe DAL / future) | Powered now? | Needs future data | Risk |
|---|---|---|---|---|
| Contract renewal timeline | `contracts` renewal/end dates (`contract-attention`) | Yes | no | low |
| Spend by app | contract totals now; observed spend later | Partial (contract totals only) | M-001 for real spend | med |
| Spend by org | contract totals by org now; observed spend later | Partial | M-001 | med |
| Apps missing owner | `apps` (`hasOwner`) | Yes | no | low |
| Apps missing contract | `apps` (`linkedContractCount`) | Yes | no | low |
| Files pending review | `files` (`uploadStatus`) | Yes | no | low |
| Connector / source health | connector metadata now; source-health later | Partial (connector Tier-1 only) | M-001 source health | med |
| Needs-attention queue | `needs-attention` DAL | Yes | no | low |
| Account match coverage | `people` / `app-account-intelligence` | Yes | no | low |
| Upcoming renewals | dashboard overview (`bucketRenewals`) | Yes | no | low |
| Top apps by contract value | `contracts` + `app_contracts` rollup | Partial (contract value only) | M-001 for actual spend | med |

**Rule:** every widget is backed by an **existing safe DAL** (or a future explicitly-RLS-reviewed view) — never an
ad-hoc query. "Partial" widgets ship with honest "contract totals, not invoice actuals" framing until M-001 lands.

---

## 8. RLS and security model

- **Every dashboard/widget row is tenant-scoped**; `tenant_id` is resolved **server-side**, never caller-supplied.
- **Visibility is enforced by RLS** (private/tenant/org/role) — not by frontend filtering.
- **Widgets must not bypass source-table RLS.** A widget reads only through the **existing safe DALs** (or explicit,
  RLS-reviewed read-only views) — it cannot widen what the caller may already see.
- **No raw SQL / user-authored query widgets. No arbitrary JS / expression widgets.** Widgets are code-defined
  definitions + safe config only.
- **No public / unauthenticated dashboard links** until a separate design (D-009) with its own RLS proof; **no
  cross-tenant sharing** ever.
- **No service-role in any app/client path** (unchanged v3 invariant; enforced by the existing build gate).

---

## 9. Widget configuration safety

**Allowed config types (only):**
- fixed **enum** filters (status, category — from a known set),
- **date-range presets** (last 30/90 days, this quarter, etc. — no free-form SQL dates),
- **org/app/contract ids chosen from the caller's RLS-visible options** (and re-validated at render),
- **limit** numbers within bounds,
- **sort fields from an allowlist**.

**Forbidden initially (hard):** arbitrary SQL · arbitrary JS · dynamic table names · unbounded filters · raw JSON query
configs · public/unauthenticated embed tokens · cross-tenant dashboard sharing. These are the injection / RLS-bypass /
DoS / leak surfaces — excluded by construction.

---

## 10. Create / edit dashboard workflow (future)

The safe future flow (all writes migration-gated + RLS-reviewed; **not built**):
1. Create dashboard from **blank or template**.
2. Set **name / description**.
3. **Add widget** from the code-defined catalog (§7).
4. **Configure** the widget with safe controls only (§9).
5. **Preview** with RLS-scoped data (the creator's own visibility).
6. **Save** (audited write).
7. **Reorder** widgets · **remove** widgets · **duplicate** dashboard · **archive** dashboard.

**This is future work; it requires a reviewed migration + RLS design + RLS tests before any write ships.**

---

## 11. Templates

| Template | Audience | Possible now? |
|---|---|---|
| Executive SaaS Governance | leadership | Yes (KPIs + renewals + attention from existing data) |
| Contract Renewal Control | procurement | Yes (renewal timeline + upcoming + missing-date) |
| App Ownership Hygiene | IT ops | Yes (missing owner / missing contract / catalog) |
| Spend Intelligence | finance | **Future-gated** (needs M-001 spend data) |
| People Risk / UAR | security | **Future-gated** (needs identity/license data + privacy review) |
| Connector Health | IT ops | **Future-gated** (needs M-001 source-health; connector live sync stays gated) |

Templates are **code-defined first** (reviewable, versioned), and can become DB-backed reference data later (Open
Questions).

---

## 12. Failure modes and defenses

| Failure mode | Defense |
|---|---|
| Dashboard sharing leaks data | visibility enforced by RLS; grants only widen **within tenant**; no cross-tenant/public |
| Widget queries bypass RLS | widgets read only through existing safe DALs / RLS-reviewed views; no ad-hoc SQL |
| Saved filters reference inaccessible orgs/apps | ids re-validated against the caller's RLS-visible set at render |
| Stale widgets after schema changes | widget definitions are versioned/code-defined; unknown key → graceful "unavailable" |
| Public links bypass auth | no public links until D-009 with separate RLS proof; none in first build |
| Builder becomes a raw report builder | catalog + allowlisted config only; forbidden operators (§9) excluded by construction |
| Too many widgets degrade performance | per-dashboard widget cap + per-widget query bounds (limits) + caching design (D-010) |
| User-supplied query injection | no user SQL/JS/JSON-query anywhere; config is enums/presets/allowlisted ids |
| Deleted/archived entities break widgets | widgets resolve entities by RLS read; missing → safe empty state, never an error/leak |

---

## 13. Build order

- **D-001 — design doc only (THIS doc).** No schema, no code.
- **D-002 — read-only dashboard library shell** using static/predefined cards (no persistence, no writes).
- **D-003 — widget catalog design + safe widget definitions** (code-defined).
- **D-004 — schema / RLS proposal** for saved dashboards + widgets (+ RLS test matrix).
- **D-005 — migration-gated saved-dashboard foundation** (tables RLS-enabled + default-deny; DALs; RLS tests;
  staging-apply only, **no production apply**; no UI).
- **D-006 — create / edit dashboard UI.**
- **D-007 — widget configuration / reordering.**
- **D-008 — dashboard templates.**
- **D-009 — sharing / visibility** — **only after RLS proof**; still no public links without separate design.
- **D-010 — performance / caching strategy.**

---

## 14. Non-goals for this PR

This PR **does not**: add migrations · add dashboard tables · add widget tables · add dashboard writes · add dashboard
sharing · add public links · add a report builder · change the current dashboard UI · add code · change RISK-007 ·
unblock Phase C · run live sync · touch production. Design document only.

---

## 15. Open questions

- Should dashboards be **tenant-wide, org-scoped, private, or all three** (and what is the default)?
- Should saved dashboards use **role-based visibility** — and which roles?
- What is the **minimum useful read-only dashboard library shell** (D-002) worth shipping first?
- **Which widgets** can be powered by current v3 safe data (see §7 "now") vs which wait?
- **Which widgets require M-001** spend-intelligence data before they're honest?
- Should **templates be code-defined first** before DB-defined?
- How should **dashboard changes be audited** (reuse the append-only audit trigger pattern)?
- Should dashboard sharing **ever** support external/public links — or is tenant-internal the hard ceiling?
- What **RLS test matrix** is required before any dashboard **write** (per-table: tenant isolation, visibility
  enforcement, default-deny, no-service-role, append-only audit, cross-tenant reject, saved-filter re-validation)?

---

*Design-only. No schema, tables, widgets, dashboard writes, migrations, or UI exist or are created here. RISK-007
remains OPEN; Phase C remains BLOCKED; connector live data-sync has not run; production untouched; old-app parity is
NOT complete.*
