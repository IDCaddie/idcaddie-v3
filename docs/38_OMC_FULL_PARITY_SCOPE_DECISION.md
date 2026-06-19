# 38 · OMC Full-Parity Scope Decision

**Product decision of record:** for the OMC/Flywheel cutover, **v3 must fully replace the old app** — full
old-app parity is the cutover bar, not an MVP subset. This doc resolves the MVP-vs-full-replacement tension that
[37 §6](./37_EXISTING_PARITY_DOCS_AUDIT.md) flagged. **Decision record only — it builds no feature and waives
nothing.**

> ## ⚠️ STATUS BANNER (do not remove)
> - **OMC requires full old-app parity before cutover unless OMC explicitly waives a specific capability** (in
>   writing). **The MVP subset framing is not sufficient for OMC cutover.**
> - **Old-app parity is not complete. UI/UX parity is not complete. AI/API connector parity is not complete.**
> - **Hosted Auth/tenant-context is verified, but old-app replacement is not yet verified.**
> - **RISK-001 remains OPEN. Cutover remains BLOCKED. Upload is not automatically production-ready. Storage
>   completion is necessary but not sufficient for cutover.**
> - No doc 17 §5 box is ticked here; no risk disposition is changed; no feature is built.

---

## 1. The decision

OMC needs **everything** the old app does. Therefore **OMC requires full old-app parity before cutover unless
OMC explicitly waives a specific capability** — a waiver is valid **only** in writing, recorded as
`removed-approved` / `deprecated-approved` / `not-used-by-OMC` in [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)
with the OMC owner's signoff + rationale (the existing [17 §6](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) /
[36 §6](./36_OMC_ACCEPTANCE_SIGNOFF_PLAN.md) taxonomy). **No implicit deferrals.** This is binding for cutover
scope and supersedes any narrower "MVP" framing.

---

## 2. Why the MVP subset is not sufficient

`v3-product-scope.md` framed v3 as an MVP that **deferred** AI extraction, API/SaaS connectors, dashboards,
reporting, SSO/SCIM, and billing. That framing is legitimate **product-planning history** — it is **not** the
OMC cutover bar. **The MVP subset framing is not sufficient for OMC cutover:** OMC is a paying production
**replacement**, so a deferred-feature list reads, for cutover purposes, as a list of **cutover blockers** —
not approved omissions. Anything "deferred" is in-scope for parity unless OMC waives it (§1).

---

## 3. In-scope by default (unless explicitly waived by OMC)

The following are **in scope for parity** and are **cutover blockers** until built + verified **or** explicitly
waived by OMC in writing (§1): **AI contract analysis, AI app/license intelligence, API/SaaS connectors,
imports, exports, reporting, dashboards, old-app UI/UX,** and **all critical old-app workflows** (§6). "Better
than legacy" does not waive a behavior; only an OMC-signed waiver does.

---

## 4. Doc reconciliation (no silent contradiction)

- **MVP scope (`v3-product-scope.md`) remains as historical / product-planning context** — it is **not deleted**
  and is annotated as **superseded for cutover** by this decision.
- **For OMC cutover, the controlling scope is [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) (the gate) +
  [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) (the line-item matrix) + this doc 38 (the decision)** — these
  supersede the MVP subset for cutover. The earlier "~25–40 PR" optimistic sizing only holds **if** OMC waives
  large areas in writing; absent waivers, the full matrix stands (§8).
- [37](./37_EXISTING_PARITY_DOCS_AUDIT.md) §6 already flagged this tension; this doc is the recorded resolution.

---

## 5. Full-parity cutover rule

1. **If the old app has it, v3 must have it.**
2. **If v3 does not have it, it is a cutover blocker.**
3. **If OMC does not need it, OMC must explicitly mark it waived / not-needed** (in writing, recorded as
   `removed-approved` / `deprecated-approved` / `not-used-by-OMC` in doc 27 with OMC signoff).
4. **No implicit deferrals.** Silence is "required", never "waived" — an unconfirmed/`unknown` row counts as
   required until OMC resolves it (the [18](./18_OMC_CONFIRMATION_PASS.md) confirmation pass).

---

## 6. Required parity categories

Each is **in scope** and a **cutover blocker** until `complete` + verified **or** OMC-waived (§1/§5). Status =
v3 today (built / partial / boundary-only / not-built), per [37 §5](./37_EXISTING_PARITY_DOCS_AUDIT.md).

| # | Category | v3 status today |
|---|---|---|
| 1 | UI/UX and navigation | partial (auth shell only; UX uncertified) |
| 2 | Dashboard / home | not built |
| 3 | Apps inventory / detail | built (read), unverified-on-hosted-flows |
| 4 | App users | built (read), unverified |
| 5 | Identity users / employees | boundary-only (schema, no directory) |
| 6 | App-user ↔ identity matching | partial (match-status read only) |
| 7 | Contracts list / detail / create / edit | built (read + create/edit), partial fields |
| 8 | Contract steward / write workflow | built (`0004` authority + `0010` audit) |
| 9 | Contract-file relationship | boundary-only (schema; not surfaced) |
| 10 | File upload / download | boundary-only (bucket+policies done; no upload/signed-URL/preview) |
| 11 | Spend / license / account intelligence | mostly not built (account-intel read only) |
| 12 | Shadow IT / unmanaged accounts (UAR) | not built |
| 13 | SaaS license optimization | not built |
| 14 | Imports | not built (must be non-destructive upsert + preview) |
| 15 | Exports | not built |
| 16 | Reporting | not built |
| 17 | AI contract analysis | not built (designed — doc 16) |
| 18 | AI app / license intelligence | not built |
| 19 | API / SaaS connectors | not built (designed — doc 19) |
| 20 | Connector token storage / security (vault) | not built (RISK-007) |
| 21 | Connector ingestion / audit logs | not built |
| 22 | Admin / settings | not built |
| 23 | Audit / history | boundary-only (`audit_logs` + `0010`; no viewer) |
| 24 | Roles / permissions | built (RLS; tenant/org memberships) — admin UI not built |
| 25 | Legacy OMC data migration | planned (doc 34), not executed |
| 26 | Rollback / recovery | planned (doc 35), not rehearsed |
| 27 | OMC acceptance / signoff | planned (doc 36), not recorded |

**Most categories are not built.** Old-app parity is not complete. UI/UX parity is not complete. AI/API
connector parity is not complete.

---

## 7. Recommended next PR sequence (full-parity)

Supersedes the narrower sequence; grounded in the docs, no invented completed work:

1. **Full old-app inventory / direct inspection** — inspect the live old app directly (not just
   `current-product-map.md`) to capture every surface/field/workflow; resolve the [18](./18_OMC_CONFIRMATION_PASS.md)
   confirmation pass (which rows OMC actually uses → eligible waivers).
2. **Master full-parity matrix** — fold the inspection into [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md) as the
   single line-item source of truth (every row required unless OMC-waived).
3. **Build missing core workflows** — files upload/download, people/identity directory + UAR, contract
   field-parity + link/unlink + delete/archive, spend/license, admin/settings, audit viewer, dashboards,
   imports/exports/reporting (each its own PR, citing its doc 27 row + RLS tests + hosted validation + evidence).
4. **Build AI/API connector parity** — connector credential vault first ([19](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md),
   RISK-007), then connectors + ingestion/audit, then AI contract + app/license intelligence ([16](./16_CONTRACT_PDF_AI_EXTRACTION_DESIGN.md)).
5. **OMC-shaped staging data validation** — execute [32](./32_STAGING_OMC_SHAPED_DATASET_AND_CRITICAL_FLOW_VALIDATION.md)
   against the built surfaces (+ the hosted RLS suite run, [30 §6](./30_DOC17_CUTOVER_BLOCKER_SEQUENCE.md)).
6. **Migration rehearsal** — execute [34](./34_OMC_LEGACY_DATA_MIGRATION_PLAN.md) dry-run + staging reconciliation.
7. **Rollback rehearsal** — execute [35](./35_CUTOVER_ROLLBACK_REHEARSAL_PLAN.md) in staging.
8. **OMC acceptance** — run [36](./36_OMC_ACCEPTANCE_SIGNOFF_PLAN.md); record the signoff + any written waivers.
9. **Final cutover checklist closure** — only when all 17 [17 §5](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md)
   boxes are true does cutover become a GO.

---

## 8. Realistic PR-count warning

**Full old-app parity likely requires significantly more than the previous MVP estimate. Do not give a false low
number.** Doc 27 currently has **~169** `missing`/`partial`/`blocked` rows and doc 17 estimated **70–110 PRs**
for full parity; the optimistic **~25–40 PR** figure only applies **if** OMC waives large areas **in writing**
(§1). Absent confirmed waivers, **full parity likely means dozens of PRs** across UI/UX, files+AI, people/UAR,
license/spend, imports/exports/reporting, connectors+vault, admin/audit, plus migration + rehearsals + signoff.
**The exact count depends on the direct old-app inspection (§7 step 1)** and the OMC confirmation pass — but plan
for dozens, not a handful.

---

## 9. Risk posture

This decision **tightens** the cutover scope (more is required) — it does **not** change RISK-001's disposition.
**RISK-001 remains OPEN** (criterion 5, the doc 17 §5 checklist, is unmet). **Cutover remains BLOCKED. Upload is
not automatically production-ready. Storage completion is necessary but not sufficient for cutover.** Hosted
Auth/tenant-context is verified, but old-app replacement is not yet verified. No production/staging mutation, no
hosted command, no secrets, no feature in this PR. OMC/Flywheel is a paying production **replacement, not a
pilot**.
