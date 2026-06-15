# RLS Test Plan

Before building UI, prove these pass against local Supabase.

## Test users
- owner_a: owner in Tenant A
- editor_a: editor in Tenant A
- viewer_a: viewer in Tenant A
- org_manager_a1: manager in Tenant A / Org A1
- owner_b: owner in Tenant B

## Required cases
1. owner_a can read Tenant A apps.
2. owner_a cannot read Tenant B apps.
3. viewer_a can read but cannot update Tenant A apps.
4. editor_a can create/update Tenant A apps.
5. editor_a cannot manage tenant memberships unless policy allows it explicitly.
6. org_manager_a1 can update records assigned to Org A1 only, once scoped org policies are added.
7. org_manager_a1 cannot update records assigned to Org A2.
8. no normal user can update/delete audit_logs.
9. service-role job can write license_evaluations.
10. browser anon/authenticated client cannot read integration secrets.
