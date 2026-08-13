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
