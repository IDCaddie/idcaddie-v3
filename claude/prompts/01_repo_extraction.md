You are reviewing the legacy ID Caddie Firebase/Firestore repo as the source material for a clean v3 rebuild.

Do not write application code yet.

Mission:
Extract the product and security requirements from the old repo. Treat the old implementation as evidence, not as a pattern to copy.

Produce these files:

1. docs/current-product-map.md
- List every major screen/route.
- List every major workflow.
- List every major Firebase collection/doc shape you can infer.
- List every Cloud Function and classify its purpose.
- Mark each item as KEEP, REDESIGN, DEFER, or DELETE.

2. docs/current-security-risk-map.md
- Identify every trust boundary.
- Identify all direct Firestore access from frontend code.
- Identify all functions callable by authenticated users.
- Identify all credential/token handling paths.
- Identify all role/group/permission logic.
- Identify all data deletion/export/import paths.
- Rank risks as P0, P1, P2, P3.

3. docs/v3-product-scope.md
- Define the v3 MVP for Flywheel/Omnicom.
- Include only features needed for app source of truth, contracts, ownership, chargebacks, people/app users, stale/unmanaged users, and auditability.
- Explicitly list what is deferred.

4. docs/v3-data-model.md
- Propose a Supabase/Postgres schema.
- Include tenants, organizations, profiles, memberships, apps, contracts, app_contracts, people, identity_accounts, app_users, identity matches, license rules, license evaluations, files, invoices, audit logs.
- For each table, list columns and relationships.

5. docs/v3-security-model.md
- Define RLS policies for every tenant-scoped table.
- Define role semantics: owner, admin, editor, viewer, org_manager, org_viewer.
- Define service-role-only operations.
- Define audit log immutability.
- Define file/storage access rules.

6. docs/v3-migration-plan.md
- Define Firestore export -> transform -> Supabase staging import -> validation report -> production cutover.
- Define exact validation checks.

Do not make unsupported claims. Cite exact file paths from the legacy repo as evidence.
