# P5E15 — first customer-pilot preflight scaffolding (evidence)

**Status: customer-agnostic preparation framework BUILT. No customer identified; no pilot record created. S3 PILOT AUTHORIZATION:
BLOCKED — MISSING REQUIRED CUSTOMER EVIDENCE.** Date 2026-07-14. Staging only; production `dzbf…` **untouched**; `certificationOnly`
unchanged; RISK-007 OPEN; Phase C BLOCKED. No secret read, no token, no Graph, no ECS, no pilot/kill-switch enabled, no hosted write.

This phase built the reusable machinery for a first customer pilot so a real authorization packet can be inserted later without
redesign. It deliberately created **no** real pilot record and used **no** customer facts.

## Phase 0 — baseline (verified)

| Check | Result |
|---|---|
| v3 HEAD == origin/main == `04942d3ea…` | ✓ |
| runner HEAD == origin/main == `415e8ae4…` | ✓ |
| both worktrees clean (before this scaffolding branch) | ✓ |
| staging is the only DB target; migration max `0047`; canonical safety posture (Scheduler disabled, ECS 0/0/0, no enabled pilot) | asserted by the P5E15 GO + confirmed by this session's P5E14 hosted verification; nothing enabled since. Hosted read-only re-check deferred (no DB credential needed for scaffolding; this phase runs no hosted write) |
| no production target/identifier in any planned command | ✓ (this phase issues no execution/hosted command) |

## What was built (docs-only, sanitized)

- `docs/CONNECTOR_FIRST_CUSTOMER_PILOT_AUTHORIZATION.md` — the authorization flow + disabled-record criteria + the readiness
  checklist (VERIFIED / BLOCKED / NOT PROVIDED; every customer-specific item defaults to NOT PROVIDED).
- `docs/templates/CONNECTOR_CUSTOMER_PILOT_AUTHORIZATION_PACKET.md` — the required-fields packet template (blank opaque-reference
  fields) + completeness rules.
- Runner: `MICROSOFT_ENTRA_FIRST_CUSTOMER_PILOT_PLAN.md` (26-step first-run operator plan, documentation only),
  `MICROSOFT_ENTRA_FIRST_CUSTOMER_PILOT_ABORT_MATRIX.md` (30 abort conditions × 7 attributes),
  `templates/MICROSOFT_ENTRA_CUSTOMER_PILOT_RUN_CHECKLIST.md`, and the runner evidence doc.
- Updated: v3 risk register + changelog; runner activation gate matrix + staging operations.

## Authorization standing (the objective's 9 questions)

1. Which exact customer tenant? → **NOT PROVIDED**
2. Consent available/verifiable? → **NOT PROVIDED**
3. Connector belongs to that customer? → cannot check (no customer)
4. Credential belongs to that customer+connector? → cannot check (no reference)
5. Approved Graph permission set known? → **NOT PROVIDED**
6. Owners assigned? → **NOT PROVIDED**
7. Limits + window approved? → limits fixed by the template; window **NOT PROVIDED**
8. Preflight passable without secret/token? → machinery exists (P5E14 gate/permission/orchestrator); no packet to run it against
9. Ready for first manual run or blocked? → **BLOCKED**

## Validation (this phase — docs-only, no hosted write, no DB credential)

- v3: docs-drift gate; `check-no-real-tokens.sh` selftest + `--all`; `git diff --check`; changed-file leak + NUL scans — see the
  final report / commit for results.
- No pilot fixture created; no hosted write; no credential used.

## What remains (a real pilot requires a fresh GO)

Supply a filled, sanitized authorization packet → the binding + permission preflight, the disabled record creation, the dry-run, and
the hosted dormancy re-check run under a separate explicit GO. Only then may S3 move to **READY FOR FIRST MANUAL RUN** (never PASS);
the first customer run is itself a further separate GO. S4/S5 remain BLOCKED; no production access.
