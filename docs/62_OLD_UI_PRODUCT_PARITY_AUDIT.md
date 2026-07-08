# 62 — Old UI / Product Parity Audit (screenshot-evidenced)

> **CURRENT CURSOR (2026-07-08):** `idcaddie-v3` main @ `689ea41` (PRs through **#286**); `idcaddie-connector-runner`
> main @ `84ecf6d` (untouched). Governance unchanged: **RISK-007 remains OPEN; Phase C remains BLOCKED; connector live
> data-sync has not run; production untouched.** Old-app parity is **NOT** complete. This is a docs-only product audit —
> it changes no code, schema, or security posture.

**Purpose.** Capture what the old ID Caddie app *visibly* had (from product screenshots + the prior code-derived old-repo
inventory) so v3 can rebuild the **cockpit experience** safely on the new RLS-first architecture — **without copying the
old implementation or security patterns.**

---

## 1. Executive summary

**Thesis:** *Old ID Caddie proves the desired product breadth — contracts, invoices, apps, people risk, reports, files,
and dashboards. v3 should not copy old implementation patterns, but it should rebuild that cockpit experience on the new
RLS-first architecture.*

The old app was a broad, dense SaaS-governance **cockpit**: KPI-card home, a contracts workspace with advanced
filters/export, an invoices review queue, an applications view fused with cost/license/utilization ("ELU"/waste), a
people directory, a people-**risk** view (orphaned/shadow/service accounts + spend-at-risk), and a customizable
**dashboards** library with a builder. That breadth is the target.

But — and this is the load-bearing caveat — **the old app's visible breadth is not evidence its implementation was
safe.** Its confidentiality rested on Firebase rules with client-side reads/writes, broad `list` rules, plaintext
connector secrets, and public inbound endpoints (§8). v3 has rebuilt a *subset* of the cockpit on **Postgres RLS as the
sole authorization boundary**, server-only DALs, and safe projections. The job now is to keep widening that cockpit on
the safe pattern, and to gate the data-heavy modules (invoices/license/identity) behind reviewed migrations + RLS tests.

**Where v3 is (verified 2026-07-08):** a read-only cockpit foundation — dashboards, apps (+detail), a full contracts
write flow, files (badges + KPIs + search/filter), people (account-match only), reports (counts), audit, connectors
(safe metadata), catalog, needs-attention, admin — plus a shared design system (badges, stat cards, charts, skeletons).
Most data-rich old modules (invoices, ELU/waste, people-risk, dashboard builder) are **not started** or **read-only
foundations**. Parity is **not** complete.

---

## 2. Screenshots reviewed / evidence list

Product evidence used in this audit (old-app UI screenshots + the code-derived inventory in
[56_OLD_APP_PARITY_REGISTER.md](./56_OLD_APP_PARITY_REGISTER.md) / [40_CODE_DERIVED_OLD_APP_INVENTORY.md](./40_CODE_DERIVED_OLD_APP_INVENTORY.md)):

- **Home dashboard** — KPI cards, quick links, a contracts overview, and an "expiring contracts" panel.
- **Contracts** — search, advanced filters, export, KPI cards, renewal/notice windows, per-row table actions.
- **Invoices** — search, export, "pending review" status, amount/total cards, linked/unlinked app references.
- **Applications** — search/filter/export, cost + license + utilization framing, "no data source" alert, "no linked
  contract" alert, app-user counts, ELU (effective licensed users), waste, renewal / auto-renew columns.
- **People** — search, app filter, directory + app-account status, per-person app counts, license-spend column.
- **People Risk View** — risk cards: orphaned accounts, orphaned spend, shadow accounts, possible service accounts,
  with UAR / per-app drill-downs.
- **Dashboards** — a dashboard library of saved-dashboard cards with widget counts + quick-start templates.
- **Dashboard create** — name, description, a widget canvas, and add-widget / save actions.

*(Screenshots are treated as PRODUCT evidence — "the old app showed this" — not as evidence the underlying access was
safe. The unsafe implementation is inventoried separately in §8 and [60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md).)*

---

## 3. Old-app product cockpit patterns worth preserving

Product/UX patterns (not implementations) that made the old app feel like an operator cockpit and that v3 should
rebuild on RLS-first foundations:

- **KPI-card home** that answers "what needs me this week" at a glance (expiring contracts, review queues, risk counts).
- **Dense, filterable workspaces** — search + advanced filters + export + per-row actions on the big lists (contracts,
  apps, invoices, people).
- **A fused app view** — one place tying an app to its contract, cost, license/utilization, and account roster.
- **Review queues** — "pending review" (invoices) and attention/cleanup lists as first-class surfaces.
- **A risk lens** — orphaned/shadow/service accounts + spend-at-risk, with drill-downs (UAR).
- **Composable dashboards** — a saved-dashboard library + a builder with quick-start templates.
- **Consistent chrome** — a shared page header, search toolbar, KPI row, and status/attention chips across modules.

---

## 4. Old app visible modules (inventory)

From the screenshots + the code-derived inventory (`frontend-v2` ~48 route groups; `webapp/functions` ~60+ functions;
52 scrapers). Present in the old app:

- Dashboards (library) + **dashboard builder** (`dashboards/create`, `react-grid-layout`).
- Applications inventory (`IDCApps`) + app detail/settings/scraping-config + insights (`elu` / `stale` / `uar`).
- Contracts (list / detail / create) + **Gantt/timeline** (`contracts/gantt`).
- Invoices (list / detail / per-app / admin billing invoice).
- Files (list / detail / **inbound**).
- People (directory) + **people/risks** + people/settings.
- Reports — 8 types (cost-snapshot, it-spend, license-analysis, monthly-procurement, overlap-analysis, user-comparison,
  monthly-snapshot) + **schedules**.
- Admin / company / users / groups; SSO (Okta); SCIM; billing.
- Inbound email + inbound API ingest; import/export (CSV); scheduled jobs; AI document extraction (Document AI /
  Vertex AI).

---

## 5. What v3 already rebuilt safely (verified 2026-07-08, main `689ea41`)

All read-only + RLS-scoped unless noted; each ships pure helpers + render/leak tests:

- **Dashboards** (`/dashboards`) — RLS-scoped KPI cards + dependency-free spend/renewal charts (contract data only).
- **Apps** (`/apps`, `/apps/[id]`) — inventory with server search/filter/sort + CSV; detail with org-name enrichment,
  catalog mapping, account-match summary.
- **Contracts** (`/contracts` + `/new` + `/[id]/edit`) — the one real **write** flow: create/edit + file attach,
  audited; KPI cards + renewal badges + CSV.
- **Files** (`/files`) — semantic status/type badges (#281), KPI summary cards (#282), and **search/filter/sort** (#286)
  over safe metadata (no storage paths/URLs).
- **People** (`/people`) — account presence + match-rate meter (explicitly *not* a PII directory / *not* UAR).
- **Reports** (`/reports`) — visible-to-you summary counts, deep-linked.
- **Audit** (`/audit`) — recent entries + filter (append-only; no actor id/IP/diff).
- **Connectors** (`/connectors`) — safe Tier-1 metadata + status badges (#284); never touches `connector_secrets`.
- **Catalog** (`/catalog`) — vendor→product→alias graph (safe projection). · **Needs Attention** (`/needs-attention`) —
  read-only cleanup queue. · **Admin** (`/admin`) — read-only context view.
- **Design system** — `Badge`/`StatusBadge`, `StatCard`/`StatGrid`, dependency-free charts, `MatchRateMeter`, loading
  skeletons (#283) — the shared chrome the cockpit rebuild depends on.

---

## 6. What v3 has not rebuilt yet

- **Invoices** — no surface; `invoices` is default-deny (needs a reviewed SELECT-policy migration first).
- **Application cost / license / utilization (ELU / waste)** — not started; `license_rules`/`license_evaluations` are
  default-deny.
- **People directory (real PII)** and **people-risk / UAR** (orphaned/shadow/service accounts, spend-at-risk) — only an
  aggregate account-match foundation exists; PII + identity depend on `identity_accounts` (default-deny) + a privacy review.
- **Dashboards library + builder** — v3's `/dashboards` is a fixed summary; no saved dashboards / widgets (persisting
  user-authored dashboards needs a new table + RLS).
- **Contract Gantt / timeline** — not built (dates exist; a read-only SVG timeline is safe to design).
- **Reports generation / export / schedules** — only summary counts today.
- **Group filter**, standalone file upload/inbound, SSO, SCIM, billing, AI document processing, broad provider catalog —
  not started.

---

## 7. Product parity matrix

Status = actual v3 code presence (verified). Old evidence = screenshots + `frontend-v2`/`webapp` inventory. `[unverified]`
= the recommended approach, risk, and PR-size are estimates, not a committed backlog. **Parity is NOT complete.**

| Capability | Old app evidence | v3 equivalent | v3 status | Recommended rebuild approach | Risk | PR size |
|---|---|---|---|---|---|---|
| Home dashboard | KPI cards + quick links + contracts overview + expiring panel | `/dashboards` + `dashboard-overview` | partial | Extend KPI/attention cards over members-read data; keep charts dependency-free | low | M |
| Contracts list | search + advanced filters + export + KPI + renewal/notice + row actions | `/contracts` (list + write + files + CSV + KPI) | partial (strongest) | Add search/filter/sort (mirror `/apps`); keep write flow audited | low | M |
| Contract Gantt view | `contracts/gantt` timeline | none | not started | **Design-first**: read-only SVG timeline from existing renewal/end dates (no new data, no chart lib) | low | L |
| Invoices | list + review status + amount cards + linked/unlinked app | none (`invoices` default-deny) | not started (gated: migration) | **Design + reviewed SELECT-policy migration + RLS tests** before any read surface | high | L |
| Applications | search/filter/export + cost/license/utilization + alerts + users | `/apps` (+ `/apps/[id]`) | partial | Add KPI row (P-023) + attention alerts from members-read; cost/license is gated | low | M |
| Application cost/license/utilization (ELU/waste) | ELU, waste, license, spend columns | none | not started (gated: migration) | Needs `license_*` migration + RLS tests + spend model design (M-001) | high | L |
| People directory | search + app filter + directory + app counts + license spend | `/people` (account presence + match meter) | read-only foundation | PII directory is privacy-deferred; keep aggregate/status-only until a reviewed identity/PII design | med | L |
| People risk view | orphaned/shadow/service accounts + orphaned spend + UAR | `/people` (ratio stat; "NOT UAR") | read-only foundation | **Design-first** risk taxonomy + review workflow; depends on identity + license (gated) | high | L |
| Dashboards library | saved-dashboard cards + widget counts + templates | none (fixed summary only) | not started | **D-001 design-first**: dashboard/widget model + RLS (persists user docs → new table) | med | L |
| Dashboard builder | name/description/widget canvas/add-widget/save | none | not started (gated: migration for persistence) | Static composed dashboard first; builder needs D-001 table + RLS SELECT/INSERT | med | L |
| Reports | 8 report types + export + schedules | `/reports` (summary counts) | partial | Add derived KPIs + a reports hub; generation/export/schedules later (some gated on invoices/license) | med | L |
| Files | list + detail + inbound | `/files` (badges + KPI + search/filter) | partial (rebuilt read surface) | Optional: file-additions mini-chart; standalone upload/inbound is a separate write design | low | S |
| Group filter | org/group scoping filter | none (org context exists, no group filter UI) | not started | Read-only URL filter over members-read `organizations`; no client tenant filter | low | M |
| Search/filter/export affordances | across all big lists | `/apps`, `/files`, `/catalog`, `/audit` (filters); CSV on apps/contracts | partial | Extract a shared **SearchToolbar** + extend filters to `/contracts`/`/people`/`/connectors` | low | M |
| KPI cards | KPI row on every workspace | `StatCard`/`StatGrid` on dashboards/contracts/files/reports | rebuilt (primitive) | Adopt on `/apps` (P-023), `/connectors` (P-018b), `/catalog` | low | S |
| Review queues | invoices "pending review" | `/needs-attention` + catalog alias `reviewStatus` | partial | Broaden the cleanup queue; a real review workflow needs writes (later) | low | S |
| Risk/attention cards | risk cards + attention counts | `/needs-attention` + attention flags | partial | Add a summary header + StatGrid; real remediation actions are writes (later) | low | S |

---

## 8. Do-not-copy implementation / security patterns

The old app's breadth came with unsafe implementation. **These must not be reproduced in v3** (full detail in
[60_DO_NOT_COPY_FROM_OLD_APP.md](./60_DO_NOT_COPY_FROM_OLD_APP.md)):

- **Plaintext connector secrets at rest** (rules-only protection, no encryption) — the RISK-007 concern itself.
- **Client-side Firestore reads AND writes** (~269 call sites) — confidentiality resting entirely on rules.
- **Broad `list`/`read: if request.auth != null`** — any authenticated user could enumerate whole collections; every
  user could read every user profile.
- Weak group-manager authz ("frontend should also validate"); plaintext bearer tokens compared non-constant-time.
- Public inbound HTTP endpoints; extension bulk email-hash endpoint; one-off scraper credential scripts / service-account
  keys committed on disk.

**Rule:** old UI breadth proves *what to build*, never *that the old way was safe*. v3 keeps RLS as the sole authz
boundary, anon-key-only clients, server-only DALs, and safe projections.

---

## 9. Recommended safe rebuild tracks

Design-first (docs-only) where the data is gated; build-now where it fits the proven zero-migration read-only pattern:

- **P-023** — `/apps` KPI summary row (read-only, pure `summarizeApps` over already-fetched rows). *Build now.*
- **P-018b** — `/connectors` KPI / status tiles (read-only, safe Tier-1 metadata only). *Build now.*
- **Shared PageHeader / SearchToolbar** — extract the repeated header + search/filter chrome as small presentational PRs.
  *Build now, split per page.*
- **`/catalog` + `/needs-attention` StatCard/Badge adoption** — swap local Stat / raw status text for the shared
  primitives. *Build now.*
- **D-001** — Dashboard library / widget model design (**docs-only first**): schema + RLS (SELECT/INSERT) shape for
  user-authored dashboards; a static composed dashboard as the safe interim.
- **M-001** — Spend-intelligence model design (**docs-only first**): the invoices/license/ELU/waste data model + RLS.
- **Invoices read-only design before migrations** — the reviewed SELECT-policy migration + RLS tests plan, then a
  read-only `/invoices` surface.
- **People Risk / UAR design before implementation** — the risk taxonomy (orphaned/shadow/service) + review workflow,
  gated on identity + license data.
- **Gantt / timeline read-only design** — a dependency-free SVG timeline from existing contract renewal/end dates
  (no new data, no chart library).

---

## 10. Recommended immediate backlog (safe, before 2026-07-10)

Zero-migration, RLS-first, read-only — continue the proven pattern:

1. **P-023** `/apps` KPI row.
2. **P-018b** `/connectors` KPI/status tiles.
3. **`/catalog` + `/needs-attention`** StatCard/Badge adoption.
4. **Shared PageHeader / SearchToolbar** extraction (small PRs; migrate 3–4 pages each).
5. **Design docs** D-001 + M-001 + invoices/Gantt/people-risk read-only designs (docs-only; no schema yet).

---

## 11. Migration / gated backlog (deliberate, not before the gates)

- **Invoices**, **license/ELU/waste**, **identity accounts** — each requires a **reviewed migration** adding the table
  with **RLS default-deny**, a user-scoped DAL, **RLS tests**, staging-apply only, **no production apply**. Independent
  of RISK-007 but strictly migration-first.
- **Dashboard builder persistence** — new dashboards table + RLS SELECT/INSERT (D-001 design first).
- **People PII directory / real UAR** — identity + privacy review; PII-deferred.
- **Connector live sync / broad provider catalog** — **gated on RISK-007 (OPEN) → Phase C (BLOCKED)**; R-015 → R-018 →
  R-019 → C-2c, on/after 2026-07-10, each an explicit human decision. **Not started.**

---

## 12. Final product thesis

**Old ID Caddie proves the desired product breadth: contracts, invoices, apps, people risk, reports, files, and
dashboards.** v3 should **not** copy old implementation patterns (client-side Firestore, plaintext secrets, broad
list rules), but it **should** rebuild that cockpit experience on the new RLS-first architecture — widening the safe
read-only cockpit now, and bringing the data-heavy modules (invoices, license/spend, identity/risk, dashboard builder)
online behind reviewed migrations + RLS tests, with the connector/live-sync track staying gated.

**v3 is safer and RLS-first, but not old-app parity complete.** RISK-007 remains OPEN; Phase C remains BLOCKED; connector
live data-sync has not run; production is untouched.
