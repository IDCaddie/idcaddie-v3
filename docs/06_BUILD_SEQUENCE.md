# 06 · Build Sequence

**Canonical source for: build order and "what not to build yet".** Each stage is gated on
the previous. Status uses the [taxonomy](./10_DOCS_INDEX.md#status-taxonomy). Stage 1 is
`implemented`/`verified-local`/`ci-enforced`; everything below is `planned` or `deferred`.

Global "done" for every stage: code + tests + docs updated, `04_RISK_REGISTER` and
`05_ENGINEERING_CHANGELOG` updated, [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md)
passed, CI green.

| # | Stage | Status |
|---|-------|--------|
| 1 | Clean-app operating system (docs/CI/foundation) | `implemented` |
| 2 | Auth/session skeleton | `implemented` (PR #6) |
| 3 | Tenant/org context (read-only) | `planned` (next) |
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

### Stage 3 — Tenant/org context (read-only) (next)
- **Goal:** derive the user's tenant + org memberships server-side; expose read-only context.
  Replaces the `src/lib/auth/tenant-context.ts` placeholder.
- **Prereq:** Stage 2 ✅.
- **P0 risks:** tenant/org from client input instead of membership rows; RLS bypass via service-role.
- **Tests:** RLS-scoped read returns only the user's tenant; cross-tenant returns 0 (extend `org_rls_test.sql` patterns at the app layer with an integration test).
- **Done:** context comes only from membership rows; proven RLS-scoped read end-to-end.

### Stage 4 — Read-only app inventory
- **Goal:** first real screen — list `apps` the user may read.
- **Prereq:** Stage 3. **P0 risks:** client-side filtering; leaking deferred child-table data.
- **Tests:** org-only user sees only related apps; tenant viewer sees all tenant apps.
- **Don't build yet:** edit/create. **Done:** read-only list, RLS-scoped, no client filtering.

### Stage 5 — Contracts · Stage 6 — People/app users · Stage 7 — License rules/evaluations · Stage 8 — Files/invoices
- **Goal:** the source-of-truth surfaces, read first then writes (steward-only).
- **P0 risks:** writes outside RLS; child tables still tenant-scoped (RISK-002 — org-scope before per-org reads ship); destructive edits without audit.
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
