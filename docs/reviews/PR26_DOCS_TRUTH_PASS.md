# Review note · PR #26 — Current-state docs truth pass (after PR #25)

**Type:** docs/readiness correction. **No code, no migration, no RLS, no generated types changed.**
Main @ `84140b6` (PRs #1–#25 merged). A 4-agent adversarial audit found **30 stale current-state
claims** — concentrated in *narrative* prose that froze around PR #5/#6 while the incrementally-updated
status *tables* stayed correct. All 30 are fixed here.

## What stale claims were fixed
**Built read-only surfaces were described as missing / "no product UI":**
- `00`: "Current phase: Phase 2 … No product UI (inventory/contracts/etc.)"; "Merged PRs" table stopped
  at #5 with "PR #6 not yet merged"; "Next safest build step / Next recommended PRs" = the (long-done)
  app-inventory page; "Can we deploy? No. No UI…"; verified stamp `ee59c6c`/2026-06-15.
- `01`: Frontend "product UI `planned`"; repo-structure block (migrations only to `0003`, DAL `apps.ts`
  only, docs `00–10`, routes); "Current: … No product UI"; "Intentionally missing: Product UI".
- `06`: intro "everything below Stage 1 is planned/deferred"; stage table marking Stages 4–9 `planned`.
- `09`: "Current repo state" header (Phase 2, migrations `0001`–`0003`, "no product UI").
- `10`: "v3 product UI is `planned`".
- `11`: "no product UI exists yet"; §3 "a first read-only app-inventory list … every other surface is
  still missing"; OMC acceptance rows for app-detail / ownership / contracts marked "No".

**Stale counts / migration ranges:**
- `11`: "66 RLS assertions" → 152 (T1–T30). `04`: RISK-C03 "83 assertions" → the full suite (152).
- `09` (×2), `00`, `03`: merged-migration range `0001`–`0003`/`0005` → `0001`–`0008`. `03`: migration
  table extended with `0006`/`0007`/`0008`.

**Verified accurate, left as-is (not stale):** the `00` status table (lines were maintained per PR);
`13` (contract write design — re-verified: RLS authority exists, write path/UI/audit not built, audit
trigger future, no archive/soft-delete — **no overclaim**); the 152-assertion / 12-test counts; the
historical per-PR assertion counts in `05` (correct as-of-that-PR). **No risk was closed.**

## What remains intentionally blocked / not built
Hosted Supabase apply (RISK-001); contract write path/UI/audit (design only — doc 13); archive/soft-delete;
`app_contracts` writes; UAR / unmanaged-account report; identity matching *algorithm*; `people` org-read;
`identity_accounts` read; license/spend/files/invoices; provisioning; tenant switching; imports/exports;
connectors. **RISK-001 / RISK-002 / RISK-016 remain open.** Hard delete stays blocked (`0004`).

## Confirmation: nothing functional changed
Docs-only diff. `test-rls.sh` = **152** assertions (unchanged). `npm test` = **12** (unchanged).
`database.types.ts` unchanged. No migration, no RLS policy, no `src` product code.

## Current go / no-go
| Action | Go? |
|---|---|
| Contract **audit-on-write** (DB-side `SECURITY DEFINER` trigger, doc 13) | **Yes** — appropriate next step after this truth pass |
| Contract **write UI** | **No** — land audit-on-write + doc 13 §7 tests first |
| **OMC/Flywheel cutover** | **No** — blocked (P0/P1 parity not `verified` + signed off) |
| **New paid-customer onboarding** | **No** — blocked (no hosted env, no write/provisioning path, no UAR/reporting parity) |
