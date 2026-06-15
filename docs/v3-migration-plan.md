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

## Existing legacy tooling to reuse
Grounded in [current-security-risk-map.md](./current-security-risk-map.md) and the legacy repo:
- **Step 1–2 (export + immutable snapshot):** use `webapp/functions/migrationScripts/backup/backupFirestore.mjs` (recursive collection→JSON walk with `_manifest.json` and `__type` markers for timestamp/geopoint/docref/bytes), driven by `backup/backup.sh` (also `gsutil rsync` mirrors Storage). Invoke with `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_PROJECT` / `BACKUP_OUT_DIR`.
- **Regression baseline:** `webapp/functions/scripts/captureLegacySnapshot.js` freezes field-engine outputs (`engineOutputs.snapshot.json`) — use to verify v3 license/field calculations match legacy.

## Migration caveats from extraction
- **Secrets are excluded from backup.** `backupFirestore.mjs` skips `APIKeys`, `inboundTokens`, `_settings`, and all `*/private/**` (scraper creds, Okta tokens). These will NOT export and must be **re-provisioned** in v3 (encrypted, service-role only) — they are not migrated.
- **Do not port destructive reconciliation.** Legacy import full-replaces and hard-deletes unmatched app users (`onFileLinkedToApp.js:283-290`). The transform step must produce upserts + soft-deletes + an audit row per add/remove, not a wholesale replace.
- **Multi-tenant transform.** Legacy is single-tenant per project; the transform must stamp `tenant_id` onto every row (one source project → one tenant) and map legacy `groups[]`/roles to the v3 org + membership model (no legacy org tier exists — orgs are assigned during transform, not migrated).
- **Audit history.** Legacy hard-purges `logs` at 90 days; only post-cutoff history exists. Decide whether to import surviving `logs` into `audit_logs` (read-only/archival) or start audit fresh at cutover.

## Validation additions (from extraction)
- Org assignment present on every app/contract/file (since org scope is net-new and assigned, not migrated).
- No plaintext credential or token rows migrated (confirm exclusion held).
- App-user counts reconcile after non-destructive upsert (no silent drops vs. legacy full-replace).
- Identity-match counts (`app_user_identity_matches`) match legacy `people`/`appAssignments` matched totals.
