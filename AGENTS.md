<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Rigor is proportional to risk

Canonical: [`ENGINEERING_STANDARDS.md`](ENGINEERING_STANDARDS.md). Read it once (a few minutes); it
is not restated here. Entry point for the repo: [`README_START_HERE.md`](README_START_HERE.md).

Every session, before writing code:

1. **Determine the baseline risk tier first** — `bash scripts/pr-review-summary.sh` prints
   `baselineRiskTier` + `riskReasons` (rules: `scripts/change-risk-lib.mjs`).
2. **Then perform semantic escalation yourself.** The classifier reads paths, not behavior. If the
   change actually forwards a credential, calls a privileged/`SECURITY DEFINER` RPC, writes connector
   state, or builds an outbound `Authorization` header, escalate it regardless of the baseline.
3. **Automated classification can never justify de-escalation** — only escalation.
4. **Speed and safety are both requirements.** Do not apply T3 ceremony to a T0/T1 change without
   naming the higher-risk failure class it catches. Do not skip T3 controls to move faster.
5. **Keep provider fact, normalized fact, and governance truth distinct** — never overwrite provider
   evidence to fit a normalized abstraction, and keep governance findings reproducible from evidence.

# What a change is allowed to claim

Canonical: [`DESIGN.md`](DESIGN.md). Read it before any user-visible change. The rule it exists to
enforce: **unavailable is not empty, failed is not zero, never-run is not complete-zero, stale is not
absent, proposed is not accepted.** The data layer returns the state; the component renders it.

# Exact-head review discipline

Every PR gets one independent review of its **exact head**; depth is risk-proportional
([`ENGINEERING_STANDARDS.md` §T, §U](ENGINEERING_STANDARDS.md)). The PR template carries the record
fields — fill every one; `N/A` is an answer, blank is not.

**Any commit after that review invalidates it.** Push again → update `HEAD_SHA`, re-run CI on the new
head, get the review re-applied. Never infer a merge gate by parsing a bot's comment text.

# STOP — ask a human first

Do not proceed on your own with any of these:

- pushing to `main`, merging, or bypassing CI ([09 · Connected agent permissions](docs/09_AGENT_HANDOFF.md#connected-agent-permissions));
- anything against hosted Supabase, or a service-role key outside approved server/test paths ([07](docs/07_P0_REVIEW_CHECKLIST.md));
- taking a lane that owns hosted DB mutation, migration apply, provider-live exercise, production deploy, or the next migration number — only one lane holds those at a time ([§W](ENGINEERING_STANDARDS.md));
- editing a merged migration, weakening RLS, or widening a read scope (fix forward; RISK-002);
- adding telemetry, auth, billing, imports/exports, or an integration that was not asked for;
- a user-visible workflow change without parity approval ([14](docs/14_LEGACY_UX_WORKFLOW_PARITY_MAP.md)).
