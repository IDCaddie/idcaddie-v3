# 06 · Build Sequence

**Canonical source for: build order and "what not to build yet".** Each stage maps to legacy→v3
capability parity and the OMC cutover gate in [11_LEGACY_PARITY_AND_OMC_CHECKLIST](./11_LEGACY_PARITY_AND_OMC_CHECKLIST.md#6-updated-roadmap-next-prs-to-parity).
Each stage is gated on
the previous. Status uses the [taxonomy](./10_DOCS_INDEX.md#status-taxonomy). Stage 1 is
`implemented`/`verified-local`/`ci-enforced`; everything below is `planned` or `deferred`.

Global "done" for every stage: code + tests + docs updated, `04_RISK_REGISTER` and
`05_ENGINEERING_CHANGELOG` updated, [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md)
passed, CI green.

| # | Stage | Status |
|---|-------|--------|
| 1 | Clean-app operating system (docs/CI/foundation) | `implemented` |
| 2 | Auth/session skeleton | `implemented` (PR #6) |
| 3 | Tenant/org context (read-only) | `implemented` (PR #9) |
| 4 | Read-only app inventory | `planned` |
| 5 | Contracts | `planned` |
| 6 | People / app users | `planned` |
| 7 | License rules / evaluations | `planned` |
| 8 | Files / invoices | `planned` |
| 9 | Audit log UI | `planned` |
| 10 | Reports / exports | `deferred` |
| 11 | Import flows | `deferred` |
| 12 | Integrations / connectors | `deferred` |
| 13 | Org hierarchy / `resource_org_links` | `deferred` |
| 14 | Billing / pricing | `deferred` (only if needed) |

---

### Stage 1 — Clean-app operating system ✅
- **Goal:** repo is self-explaining, self-checking, RLS-tested. **Done:** docs 00–10, RLS
  suite + safety + docs-drift CI all green.

### Stage 2 — Auth/session skeleton ✅ (PR #6)
- **Goal:** Supabase Auth login + server-side session + route protection. No business data. **Done.**
- **Built:** `@supabase/ssr` browser + user-scoped server clients (anon key only); `src/proxy.ts`
  (Next.js 16 Proxy) for session refresh + protected-route redirect; `login/` (email+password
  Server Action), `logout/` route handler, `(authenticated)/` group with a server-side guard;
  `src/lib/auth/` session + tenant-context placeholder.
- **Verified:** `npm run build` + lint clean; `scripts/check-auth-safety.sh` (no service-role /
  no hardcoded keys / no client-side role storage). **Not** exercised against hosted Supabase Auth.
- **Deliberately not built:** business reads/writes, tenant switching UI, signup/tenant creation,
  OAuth/SAML/SCIM, tenant/org context resolution.

### Stage 3 — Tenant/org context (read-only) ✅ (PR #9)
- **Goal:** derive the user's tenant + org memberships server-side; expose read-only context. **Done.**
- **Built:** `resolveTenantContext()` reads own `tenant_memberships`/`organization_memberships` (+
  embedded `tenants`/`organizations`) via the user-scoped server client — RLS-scoped, no service-role,
  no client filtering, no JWT claims. Active tenant = deterministic first (no switcher). Pure derivation
  in `tenant-context-derive.ts` with unit tests; resolved context shown in the protected shell.
- **Zero-membership:** safe — `no_membership` / `no_tenant_membership` states, "No tenant access
  configured yet", no crash, nothing created.
- **No migration** (existing RLS already permits these reads). **Not built:** tenant switching, provisioning.

### Stage 4 — Read-only app inventory ✅ (PR #13)
- **Goal:** first real screen — list `apps` the user may read. **Done.**
- **Built:** `src/app/(authenticated)/apps/page.tsx` — server-rendered, consumes `listAppsForCurrentUser()`
  (PR #11 DAL), shows name/vendor/category/status, with safe empty + generic error states and no
  create/edit/delete. A link to it from the protected shell. No new queries, no client-side filtering.
- **Verified (RLS query against the seeded fixture):** tenant owner sees all 3 demo apps; the org-only
  Marketing user sees only the 2 apps related to their org (RLS `0003` org-union read); a non-member sees 0.
- **Don't build yet:** edit/create, app detail, contracts UI, imports/exports.

### Stage 4b — Read-only app detail ✅ (PR #14)
- **Goal:** drill-down for one app (read-only). **Done.**
- **Built:** `src/app/(authenticated)/apps/[id]/page.tsx` + `getAppDetailForCurrentUser(id)` (typed DAL).
  Shows name/vendor/category/status/timestamps + owning-org IDs; app names in `/apps` link here. The
  `[id]` route param is a **lookup key only** — RLS decides; hidden rows → `not_found` (no enumeration).
- **Verified (RLS query):** owner reads all 3 demo app details; org-only Marketing reads only its 2
  related, and the unrelated app + non-member → 0 (not_found).
- **Deferred (documented):** org-name enrichment (IDs shown for now); app-user roster, linked contracts,
  invoices, files, license rules, and all edits — **not** built.

### Stage 5 — Contracts · Stage 6 — People/app users · Stage 7 — License rules/evaluations · Stage 8 — Files/invoices
- **Goal:** the source-of-truth surfaces, read first then writes (steward-only).
- **P0 risks:** writes outside RLS; child tables still tenant-scoped (RISK-002 — org-scope before per-org reads ship); destructive edits without audit.
- **Delete guardrail (PR #16 / `0004`):** core evidence tables have **no hard-delete** policy — write surfaces add `INSERT`/`UPDATE` only; never re-add `FOR ALL`/`DELETE`. **Hard delete + archive/soft-delete UI are deferred** to a future audited admin/break-glass path (not built — RISK-C07).
- **Integrity guardrail (PR #17 / `0005`):** child/link writes that reference a cross-tenant parent fail at the DB (composite same-tenant FKs). New child tables must add the same `(parent_ref, tenant_id) → parent(id, tenant_id)` FK. Org-scoped child-table **reads** are still deferred (RISK-002).
- **Tests:** steward write allowed, non-steward denied, related-org read works; audit row written on change.
- **Done:** each surface read-then-write under RLS, audited.

### Stage 9 — Audit log UI
- **Goal:** read-only audit viewer. **P0 risks:** exposing secrets in logged fields; any write path to `audit_logs`.
- **Tests:** no UI write path; safe fields only. **Done:** read-only, append-only respected.

### Stage 10 — Reports/exports (deferred)
- **Rule:** exports MUST be tenant-scoped; never export credentials/secrets; no cross-tenant rows. **Done:** scoped + audited export with tests.

### Stage 11 — Import flows (deferred)
- **Rule (pre-committed):** preview before write · upsert + soft-delete (no blind full-replace, no hard delete) · provenance + idempotency · row-level audit · duplicate detection. Ties to legacy findings ([current-security-risk-map.md](./current-security-risk-map.md)). **Done:** non-destructive, audited, tested import.

### Stage 12 — Integrations/connectors (deferred)
- **Rule:** credentials encrypted + service-role-only (never app tables/browser/logs/exports); dry-run; scoped tokens; no destructive deactivation without approval. Gated on a credential-vault design (RISK-007). **Done:** one connector behind the vault, idempotent, tested.

### Stage 13 — Org hierarchy / `resource_org_links` (deferred)
- **Goal:** parent→child org inheritance and/or relationship-based access replacing column union (RISK-003/004). **Done:** migration + RLS + tests; column model superseded intentionally.

### Stage 14 — Billing/pricing (deferred, only if needed)
- Build only if the product requires in-app billing beyond chargeback reporting.
