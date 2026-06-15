# ID Caddie v3 Migration Plan

## Strategy
Do not live-migrate blindly. Create a repeatable migration pipeline.

1. Export Firestore data from current tenant instance.
2. Save immutable raw JSON snapshot.
3. Transform to relational staging format.
4. Import into Supabase staging.
5. Run validation report.
6. Manually review high-risk records.
7. Freeze old writes briefly.
8. Import into production.
9. Run validation report again.
10. Cut over DNS/app links.

## Validation checks
- App count matches.
- Contract count matches.
- File metadata count matches.
- Invoice count matches.
- Person count matches.
- App-user count matches.
- Total spend by vendor matches.
- Total spend by app matches.
- Renewal dates match.
- License type counts match.
- Stale user counts match.
- Unmanaged user counts match.
- Every migrated row has tenant_id.
- Every file path is tenant-scoped.
