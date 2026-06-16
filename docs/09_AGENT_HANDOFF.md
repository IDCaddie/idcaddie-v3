# 09 · Agent Handoff

**Canonical source for: how a coding agent (Claude/Codex/etc.) safely continues work.**
Read this + [00_PRODUCT_STATUS](./00_PRODUCT_STATUS.md) before doing anything. Repo rules
also live in `AGENTS.md` / `claude/CLAUDE.md`.

## Current repo state (verify before trusting — see [00](./00_PRODUCT_STATUS.md))
Phase 1 — data/RLS foundation only. Migrations `0001`–`0003` are `implemented`,
`verified-local`, `ci-enforced`, **not hosted-applied**. No product UI (Next shell only).
Legacy Firebase is still production. Don't trust any prompt's "seeded" history — re-verify
from `git log`, `gh pr list`, `ls supabase/migrations`, and the test files.

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
   bash scripts/check-docs-updated.sh
   bash scripts/pr-review-summary.sh
   ```
3. Update docs per the [docs-update policy](./08_CODE_AND_DOCS_STANDARD.md#required-updates-per-change-docs-update-policy):
   at minimum add a [05_ENGINEERING_CHANGELOG](./05_ENGINEERING_CHANGELOG.md) entry; touch
   [04_RISK_REGISTER](./04_RISK_REGISTER.md) if risk changed.
4. Self-review against [07_P0_REVIEW_CHECKLIST](./07_P0_REVIEW_CHECKLIST.md).
5. Apply the [ponytail pass](./08_CODE_AND_DOCS_STANDARD.md#ponytail-pass-before-any-pr) — build the smallest safe thing.

## Current next recommended task
The **auth/session skeleton** (build-sequence Stage 2): Supabase Auth login, server-side
session, route protection. No business reads/writes. Prereqs met. P0 watch: no service-role
in request paths; session server-side. After that: read-only tenant/org context (Stage 3).

## Current open risks to respect
`not-hosted-applied`; child tables tenant-scoped (org scoping deferred); no auth yet; no
credential vault; imports/exports destructive-in-legacy (don't port). Full list:
[04_RISK_REGISTER](./04_RISK_REGISTER.md).

## How to summarize at the end of a PR
State: what changed, what you **verified** (with the command output), what is still
unverified/deferred, which docs/risk/changelog you updated, and the next safe step. Do not
overstate. Surface uncertainty explicitly.

## How to avoid hidden context
If a fact matters, put it in a doc, test, script, CI check, the risk register, or the
changelog — **not** in chat or memory. The next agent should need nothing but the repo.
