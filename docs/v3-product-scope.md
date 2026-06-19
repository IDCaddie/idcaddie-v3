# ID Caddie v3 Scope

> **⚠️ SUPERSEDED FOR CUTOVER — historical product-planning context only.** This doc's **MVP subset** framing
> (which defers AI/connectors/dashboards/reporting/SSO/billing) is **not** the OMC cutover bar. For the OMC/
> Flywheel cutover, **full old-app parity is required unless OMC explicitly waives a capability in writing** —
> see the decision of record [38_OMC_FULL_PARITY_SCOPE_DECISION](./38_OMC_FULL_PARITY_SCOPE_DECISION.md) (+ the
> gate [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) and matrix [27](./27_LEGACY_OMC_FULL_PARITY_MATRIX.md)).
> **The MVP subset framing is not sufficient for OMC cutover.** Anything "deferred" below is a cutover blocker
> unless OMC-waived. This doc is kept as history; it is not deleted.

## Product framing
ID Caddie v3 is an enterprise SaaS governance and application source-of-truth platform.

It answers:
- What apps do we use?
- Who owns each app?
- Who pays for each app?
- Who renews each app?
- Which contract governs each app?
- Which users have access?
- Which paid users are stale, unmanaged, or unnecessary?
- Which costs should be charged back to which agency/org?

## MVP features
1. Auth/login
2. Tenant and organization model
3. User/admin/member management
4. Apps inventory
5. App ownership/responsibility fields
6. Contracts and app-contract linking
7. Files/contracts/invoices upload metadata
8. People/IdP import
9. App users import
10. Identity matching
11. License rules/evaluations
12. Stale users report
13. Unmanaged users report
14. Spend/chargeback fields
15. Audit log

## Deferred
- Browser extension
- Generic scraping sprawl
- Full AI document analysis
- Complex custom dashboards
- All legacy report variants
- All Firebase-specific migration helpers
- Automated deactivation/writeback into customer SaaS tools

## Evidence basis (legacy extraction)
Grounded in [current-product-map.md](./current-product-map.md). The MVP set above corresponds to the legacy **KEEP** routes/functions; deferrals correspond to legacy **DEFER/DELETE**:
- **MVP (KEEP):** `IDCApps` list/detail + insights (elu/stale/uar), `contracts` list/detail/create + app↔contract linking, `company/users`, `people` directory + risks, `files`/`invoices`, `logging` (audit). Legacy chargeback lives on apps/contracts as `fields.*`; v3 makes it explicit FK columns.
- **Deferred (legacy scope confirmed):** 53-connector scraping (`webapp/functions/src/appScraping/*`), AI document processing (`storage/processFileWithAI.js`), 8 report routes + scheduled email (`reports/*`, `email/*`), dashboards builder, SSO/SCIM (`scim/*`), subscription billing (`admin/billing`), Chrome extension, inbound API/email ingest.
- **Net-new for v3 (no legacy analog):** org/agency tier (`org_manager`/`org_viewer`). Legacy is single-tenant with no org concept — a design change, not a migration.
