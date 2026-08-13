# ID Caddie Engineering Standards — v0.1

**Canonical source for: how much rigor a change earns.** Governs `idcaddie-v3` and
`idcaddie-connector-runner`. It does not restate [07 P0 Review
Checklist](docs/07_P0_REVIEW_CHECKLIST.md), [08 Code & Docs
Standard](docs/08_CODE_AND_DOCS_STANDARD.md), or [02 Security &
RLS](docs/02_SECURITY_AND_RLS.md) — it decides which of them a change has to satisfy.

**ID Caddie optimizes for maximum safety per minute of engineering effort.** Deep controls stay
around trust boundaries; everything else moves fast. Every proposed gate must answer: *what
distinct failure class does this catch that an existing control does not?* No concrete answer, no
gate.

## A · The four gates

1. **Correctness** — does it work, and are the product/security invariants *enforced* rather than
   implied by UI copy or a comment?
2. **Security + operability** — if it fails: do we detect it, is the failure truthful, does it fail
   closed where it should, is recovery safe, is rollback understood, can provider state diverge from
   what we persisted?
3. **Maintainability** — one current architecture, appropriate tests, current comments/docs, least
   privilege, no obsolete escape hatch, no duplicate owner of the same fact.
4. **Speed** — was the minimum justified ceremony used, and did this make the *next* change easier
   rather than adding permanent process?

## B · Risk tiers

**Slack Phase-8R-level ceremony is not the default for T0/T1/T2.** T3 depth is itself proportional
to the actual failure class.

| Tier | What it is | Typical validation |
|---|---|---|
| **T0** | Documentation / non-runtime: docs, comments, catalog text, connector documentation, copy | Focused checks + normal CI |
| **T1** | Low-risk UI / local product: layout, styling, display-only components, table & filter presentation, setup instructions, dashboard polish | Focused unit/component tests, targeted browser coverage when useful, normal CI |
| **T2** | Business workflow / connector behavior: provider discovery, pagination, retry & backoff, normalization, deterministic governance findings, contract extraction, sync orchestration, background jobs, stateful workflows, notifications, provider billing/license logic | Behavioral + integration tests, partial-failure and staleness reasoning, cross-feature interaction review, observability and deployment impact |
| **T3** | Trust boundary: authn/authz, OAuth/OIDC, connector credentials, token refresh & rotation, KMS, Secrets Manager, AWS IAM/task roles, DB login roles, `SECURITY DEFINER` RPCs, RLS, tenant isolation, privileged mutation, provider callback validation, migrations, destructive operations, sensitive data, external-side-effect state machines, cross-tenant identity linkage, financial/license authority, automated destructive governance actions | Where applicable: real DB tests, real parser/client behavior, concurrency tests, negative controls, privilege closure, tenant-isolation proof, deployment-skew analysis, independent review, controlled rollout, production preflight |

T0 never earns a DB reset, security/mutation campaign, deployment-skew matrix, or broad adversarial
review unless the change actually crosses a higher boundary; T1 never automatically earns DB
integration, migration review, KMS/IAM review, or concurrency review.

`bash scripts/pr-review-summary.sh` prints the baseline tier and its reasons; the rules live in
`scripts/change-risk-lib.mjs`.

## C · Automated classification is a baseline, not semantic proof

> Automated risk classification is a baseline, not semantic proof. The classifier uses deterministic
> repository signals such as paths and change categories; it cannot detect higher-risk behavior
> hidden inside otherwise low-risk-looking files. Every implementation session and reviewer must
> perform semantic risk judgment and escalate when warranted. Automated classification may never be
> cited as justification for de-escalating a change whose actual behavior crosses a higher-risk
> boundary.

Concretely: a page or component under `src/app/` or `src/components/` baselines as **T1**. The moment
it forwards a credential, calls a privileged or `SECURITY DEFINER` RPC, writes connector state,
crosses a tenant boundary, or constructs an outbound `Authorization` header, semantic review
escalates it. A path classifier cannot see that.

## D · Provider fact ≠ normalized fact ≠ governance truth

Three distinct kinds of truth. Never collapse them:

- Slack reports an account as billable → **provider evidence**.
- ID Caddie links that account to a person → **normalized/canonical relationship**.
- ID Caddie concludes "potential unused paid license" → **governance finding**.

Never overwrite provider evidence to fit a normalized abstraction; preserve provenance; normalization
must not silently invent provider truth; governance findings must be reproducible from the evidence.
LLMs may explain or prioritize findings — they must not establish deterministic truth.

## E · Test hierarchy

Prefer, where reasonably testable: **1)** real DB/client/provider-parser behavior → **2)** real
server/runner behavior → **3)** integration → **4)** component → **5)** browser E2E → **6)**
static/source contract tests. Source tests are tripwires; they do not replace behavioral proof where
real behavior can be tested.

## F · Anti-vacuity — prove the detector works

**A security guard that has never been demonstrated to fail is not yet strong evidence.**

For important absence claims — no writer, no privilege, no capability in the bundle, no alternate
assertion producer, no cross-tenant path, no mutation, no fallback, no secret leakage — also prove
the detector works: plant a forbidden package into the real callback closure, make a deliberate
mutant turn the intended test RED, feed the scanner a known positive control, show the parser test
reflects the real client's interpretation, use a fake principal to show the privilege would be usable
if granted. Not required for trivial tests.

## G · Negative controls

For critical T3 and selected T2 invariants: deliberately break one important rule, confirm the
intended proof turns RED, restore exactly. One or two high-value controls is usually enough. The
Slack/OIDC multi-round campaigns were exceptional because that boundary repeatedly proved subtle —
not the routine.

## H · Cross-system review

For stateful T2/T3 work ask: **what other workflow can mutate this same object or fact while this
operation is in flight?** Candidates: connector syncs, OAuth completion, secret rotation,
stale/promotion workflows, identity matching, governance lifecycle, contract linkage, license
evaluation, background jobs, provider deletes/suspensions, cross-source reconciliation.

## I · External provider truth

**External provider truth is not the same as ID Caddie persisted truth.** Where a change causes an
external side effect, prefer *claim → external side effect → settle*. Never blindly retry an
uncertain provider-success state if that can duplicate the effect. No generic framework in v0.1.

## J · Database authority and privilege closure

UI explains. Application orchestrates. The database enforces where appropriate. `service_role`,
`connector_runner`, and privileged task roles are **transport authority, not permission to invent
business truth**.

Boundary changes complete in this order: introduce the governed command → migrate callers → prove
old writers are zero → revoke the obsolete privilege. Adding a governed path while leaving the old
escape hatch open is not boundary completion unless explicitly temporary.

## K · Deployment skew

For DB/app/runner contract changes, consider OLD/NEW app × OLD/NEW DB. For vendored cross-repo
contracts (`VENDOR.lock`), also OLD/NEW v3 × OLD/NEW runner. Skip the matrix where skew is
impossible.

## L · Green CI is necessary, not sufficient

CI proves what was encoded. Independent review asks whether the right things were encoded. For
appropriate T3: implementation → local proof → CI → independent review → production preflight →
controlled rollout. Never imposed on T0/T1.

## M · Exact-base / exact-head proof

For disputed regressions or sensitive merges, compare against the exact production/base commit. For
high-risk merge gates, verify the exact PR head, CI on that exact head, a clean tree, and
mergeability. Not for ordinary low-risk PRs.

## N · CI portability

Tests must not depend on a stale `.next`, full local git history, developer caches, machine-global
state, local-only files, untracked fixtures, or implicit network access. A test that only proves
something in one checkout is not portable proof.

## O · One canonical owner per fact

Provider fact owns provider evidence; the person link owns the person/account judgement; the
normalized entity owns canonical mapping; the persisted finding owns finding lifecycle; the migration
owns the historical DB invariant; `VENDOR.lock` owns cross-repo provenance. Two tables, docs, or
tests must not independently own one mutable fact unless one is intentionally derived.

## P · Comments and docs match the current architecture

Architecture-changing work removes stale comments describing the retired design. Code, tests,
comments, and runbook tell **one** current story.

## Q · Observability and operability

We already have logging, CloudWatch, EventBridge, CI, and runbooks — "add monitoring" is not a
default. For meaningful T2/T3 ask: what existing telemetry proves this works; what detects failure;
could telemetry leak credentials or tokens; is there an actionable alert, wired to a real consumer;
is recovery understood?

## R · Pain before platform

> Pain before platform. Before adding new internal engineering automation or process infrastructure,
> identify at least two concrete occasions where the missing capability caused meaningful wasted
> engineering time, risk, or a real defect.

**Evidence location:** record candidates in the originating PR under **Engineering friction /
repeated manual work**. At the re-evaluation checkpoint (§S), use those recorded examples rather than
reconstructing pain from memory.

**Foundational exceptions** (no evidence needed): secret scanning; authentication/authorization
enforcement; credential and key protection; migration-integrity controls. That list is exhaustive —
there is no "or equivalent security mechanism" catch-all. Anything else claiming an exception must
name **(1)** the failure class and **(2)** why waiting for two examples creates unacceptable risk.

## S · Re-evaluation

No calendar date. After **5–10 substantive PRs spanning at least two risk tiers**, review the
recorded friction evidence: what was repeatedly reconstructed? What consumed meaningful time or
caused avoidable errors? What did classification miss? What ceremony added little value? Did T0/T1
get faster, did T3 keep the right safeguards, and are Google, Slack, governance, and contracts moving
faster? Only repeated, evidenced pain earns v0.2 tooling.
