# ID Caddie v3 Claude Rules

You are working on ID Caddie v3, a security-sensitive B2B SaaS for SaaS license governance, application inventory, contract ownership, identity reconciliation, spend governance, renewal tracking, and chargebacks.

Security rules:
- Never trust frontend checks as authorization.
- Every tenant-scoped table must have `tenant_id` and RLS enabled.
- No browser code may use Supabase service-role keys.
- Service-role operations must be isolated to trusted server jobs/functions.
- Audit logs are append-only.
- Integration credentials must not be readable by normal app users.
- Storage paths must be tenant-scoped and protected by policy.
- Dangerous admin operations must require explicit tenant admin/owner permission.

Architecture rules:
- Do not port Firebase patterns into Supabase.
- Do not scatter database calls across UI components.
- Use feature services/actions for each domain.
- Keep frontend familiar to existing ID Caddie users, but rebuild backend cleanly.
- Prefer simple, explicit Postgres tables over JSON blobs unless raw source payload must be retained.

Development rules:
- Migration first.
- RLS tests before UI polish.
- Every feature must include at least one authorization test.
- Do not add new features until core app flows are secure and tested.
