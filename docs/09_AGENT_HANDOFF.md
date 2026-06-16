# 09 · Agent Handoff

**Canonical source for: how a coding agent (Claude/Codex/etc.) safely continues work.**
Read this + [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) before doing anything. Repo rules
also live in `AGENTS.md` / `claude/CLAUDE.md`.

## Current repo state (verify before trusting — see [00](./00_PRODUCT_STATUS.md))
Phase 2 — auth/session skeleton built on the data/RLS foundation. Migrations `0001`–`0003`
are `implemented`, `verified-local`, `ci-enforced`, **not hosted-applied**. The auth skeleton
(login, server session via `src/proxy.ts`, protected `(authenticated)/` group) is built but
**not exercised against hosted Supabase Auth**; tenant/org context is a placeholder only. No
product UI. Legacy Firebase is still production. Don't trust any prompt's "seeded" history —
re-verify from `git log`, `gh pr list`, `ls supabase/migrations`, and the source/test files.

## Non-negotiable rules
- **Never run against hosted Supabase.** Local throwaway Postgres only (`scripts/test-rls.sh`).
- **Never use service-role keys** outside trusted server/test paths; never in the client.
- **Never weaken RLS**; never filter for security in the client.
- **Never edit a merged migration** (`0001`–`0003`) — fix forward with `000N_*.sql`.
- **Never build UI ahead of its build-sequence prerequisites** ([06](./06_BUILD_SEQUENCE.md)).
- **Never claim something is verified** without command output.

## Always, every PR
1. Branch off `main`; do not commit to `main`.
2. Run the checks and paste real output:
   ```bash
   bash scripts/check-migration-safety.sh
   bash scripts/test-rls.sh
   bash scripts/check-auth-safety.sh   # if you touched src/
   bash scripts/check-docs-updated.sh
   bash scripts/pr-review-summary.sh
   ```
   For app/UI work also run `npm run lint` and `npm run build`.
3. Update docs per the [docs-update policy](./08_CODE_AND_DOCS_STANDARD.md#required-updates-per-change-docs-update-policy):
   at minimum add a [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md) entry; touch
   [04_RISK_REGISTER](./04_RISK_REGISTER.md) if risk changed.
4. Self-review against [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md).
5. Apply the [ponytail pass](./08_CODE_AND_DOCS_STANDARD.md#ponytail-pass-before-any-pr) — build the smallest safe thing.

## Current next recommended task
**Tenant/org context resolution** (build-sequence Stage 3): derive the user's tenant + org
memberships server-side from the membership tables and expose a read-only context, replacing
the `src/lib/auth/tenant-context.ts` placeholder. Prove one RLS-scoped read end-to-end. No
writes, no product UI. P0 watch: context from membership rows (not client input or JWT claims);
no service-role; do not weaken RLS. (Stage 2 auth skeleton is done — PR #6.)

## Current open risks to respect
`not-hosted-applied`; child tables tenant-scoped (org scoping deferred); no tenant/org
context resolution yet (RISK-012); no credential vault; imports/exports destructive-in-legacy
(don't port). Full list:
[04_RISK_REGISTER](./04_RISK_REGISTER.md).

## How to summarize at the end of a PR
State: what changed, what you **verified** (with the command output), what is still
unverified/deferred, which docs/risk/changelog you updated, and the next safe step. Do not
overstate. Surface uncertainty explicitly.

## How to avoid hidden context
If a fact matters, put it in a doc, test, script, CI check, the risk register, or the
changelog — **not** in chat or memory. The next agent should need nothing but the repo.
