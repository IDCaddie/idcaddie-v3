<!--
ID Caddie v3 PR template. Delete sections that are genuinely N/A, but say *why*.
Rigor is proportional to risk: ../ENGINEERING_STANDARDS.md · Review framework: docs/07_P0_REVIEW_CHECKLIST.md
Standards: docs/08_CODE_AND_DOCS_STANDARD.md
-->

## Summary
<!-- What this PR does, in 1–3 sentences. -->

## Risk
<!-- Baseline comes from `bash scripts/pr-review-summary.sh`. It is deterministic path evidence, NOT semantic
     proof — it may never justify de-escalation (ENGINEERING_STANDARDS.md §C). -->
- **Baseline risk tier:** T0 / T1 / T2 / T3
- **Semantic escalation:** None <!-- or: → T3, because this helper now forwards a credential -->
- **Risk reasons:**
- **Trust boundary changed:** No / Yes
- **Database / migration:** No / Yes
- **External provider side effect:** No / Yes

## Why this change exists
<!-- The problem/decision. Link the risk/issue if there is one. -->

## Ponytail simplification pass
<!-- What you did NOT build and why. What stdlib/existing structure you reused instead of adding new code. -->

## Existing structures inspected
<!-- Migrations, helpers, policies, scripts, docs you read before writing. Reuse > reinvention. -->

## High-risk considerations
<!-- T2/T3 only — a T0/T1 PR deletes this whole section. Do not import T3 ceremony into a T0/T1 change
     without naming the higher-risk failure class it catches (ENGINEERING_STANDARDS.md §B, §R). -->
- **Security / secrets / credentials:**
- **Tenant, org & privilege impact:** <!-- RLS, SECURITY DEFINER, service-role, privilege closure (§J) -->
- **Migration:** <!-- new migration number? append-only? hosted-apply implications? -->
- **Destructive / import / export operations:**
- **Cross-system interaction:** <!-- what else can mutate this fact mid-flight? (§H) -->
- **Deployment skew:** <!-- OLD/NEW app × OLD/NEW DB; OLD/NEW v3 × OLD/NEW runner (§K) -->
- **Failure / rollback:** <!-- how it fails, how we detect it, the revert/forward-fix path -->
- **Observability / alert impact:** <!-- existing telemetry only; could it leak a token? (§Q) -->
- **Provider fact / normalized fact / governance truth:** <!-- which layer changed, and provenance (§D) -->

## Proof
<!-- Paste real command output, not "should pass". Prefer behavioral over static proof (§E). -->
- **Focused behavioral tests:**
- **Integration / browser:**
- **Negative control:** N/A <!-- required for T3 and selected T2: break the rule → proof goes RED → restore (§F, §G) -->

## Production
- **Production access:** NONE / READ-ONLY / WRITE
- **Migration:** NONE / PENDING / APPLIED
- **Deployment:** NONE / PENDING / APPLIED

## Docs / risk / changelog
- **Docs updated:** <!-- which docs/* files, or .docs-not-needed.md justification -->
- **Risk register (docs/04):** <!-- risk opened/closed/changed, or "no risk change" -->
- **Engineering changelog (docs/05):** <!-- entry added -->

## What I intentionally did NOT change
<!-- Scope boundaries, deferred items, follow-ups. -->

## Reviewer focus areas
<!-- Where you most want eyes. -->

## Engineering friction / repeated manual work
<!-- OPTIONAL. Concrete repeated recon/evidence/process pain only — this is the evidence the Engineering OS
     re-evaluation reads instead of reconstructing pain from memory (ENGINEERING_STANDARDS.md §R, §S). -->

## Process exception
<!-- OPTIONAL. Name the failure class + why the exception is justified. -->

---

### P0 checklist (docs/07_P0_REVIEW_CHECKLIST.md)
<!-- Applies at every tier. Where a tier makes an item structurally impossible, mark it N/A and say why. -->
- [ ] I did **not** run against hosted Supabase
- [ ] I did **not** use service-role keys outside approved server/test paths
- [ ] I did **not** rely on frontend filtering for authorization
- [ ] I considered tenant isolation
- [ ] I considered org / resource isolation
- [ ] I considered telemetry/privacy impact if this PR adds analytics, performance tracking, or instrumentation
- [ ] I updated docs, or added a valid `.docs-not-needed.md`
- [ ] I updated the risk register if risk changed
- [ ] I updated the engineering changelog
- [ ] I ran the RLS tests if DB/security was touched
- [ ] I documented risky decisions
