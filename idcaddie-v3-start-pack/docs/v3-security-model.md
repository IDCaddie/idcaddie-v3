# ID Caddie v3 Security Model

## Core principle
Authorization lives in Postgres RLS, not in frontend filtering.

## Tenant boundary
Every customer-owned row has `tenant_id`.
A user can read tenant rows only if they have an active membership in that tenant.

## Roles
- owner: full tenant admin, including billing/security settings.
- admin: full operational admin, except destructive owner-only actions.
- editor: can create/update operational records.
- viewer: read-only.
- org_manager: can manage resources scoped to their organization.
- org_viewer: can read resources scoped to their organization.

## Service-role-only operations
- connector credential writes/reads
- external scrape execution
- license evaluation writes
- import processing state changes
- audit log creation from trusted server paths
- destructive bulk operations

## Required tests
- Tenant A user cannot read Tenant B data.
- Tenant A user cannot update Tenant B data.
- Viewer cannot edit.
- Editor cannot manage members/security settings.
- Org manager can edit only resources assigned to their org.
- Group/org manager access cannot escape to unrelated resources.
- Audit logs cannot be updated/deleted by normal users.
- Files are inaccessible outside tenant.
- Service-role functions do not expose raw credentials to users.
