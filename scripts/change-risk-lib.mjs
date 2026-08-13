// Deterministic BASELINE risk classification for a changed-file list — pure, no I/O, no network, no git, unit-tested
// directly (scripts/change-risk-lib.test.ts). Consumed by scripts/pr-review-summary.sh, which owns the git plumbing.
//
// This is a BASELINE, NOT semantic proof. It reads repository PATHS only; it cannot see that an ordinary-looking
// component started forwarding a credential or calling a privileged RPC. Every implementer and reviewer still performs
// semantic risk judgement and escalates when warranted — and this output may NEVER be cited to de-escalate a change
// whose actual behaviour crosses a higher-risk boundary. See ENGINEERING_STANDARDS.md §C.
//
// Design notes that are load-bearing, not decoration:
//  · Docs short-circuit FIRST. `docs/02_SECURITY_AND_RLS.md` is documentation, not a trust boundary — without the
//    short-circuit the T3 keyword rule below would read "RLS" out of the *filename* and tier a typo fix as T3.
//  · Keyword matching is delimiter-anchored (`(^|[/_.-])word([/_.-]|$)`), so `auth` matches `src/lib/auth/session.ts`
//    but NOT `src/app/(authenticated)/apps/page.tsx` (the `(` is not a delimiter) and NOT an `AuthorPill.tsx`. Every
//    app page in this repo lives under the `(authenticated)` route group, so a looser rule would tier the whole UI T3.
//  · Unmatched paths default UP to T2, never down. An unrecognised path is a prompt to look, not a clean bill.

import { pathToFileURL } from "node:url";

const TIERS = ["T0", "T1", "T2", "T3"];

// Delimiter-anchored trust-boundary vocabulary. Plurals are explicit — `migration` must not match `migrations` by
// accident, so the forms we actually want are spelled out.
const T3_WORDS = /(^|[/_.-])(auth|oauth|oidc|callback|credentials?|secrets?|tokens?|kms|iam|vault|rls|tenant|migrations?|privileged|session|login|logout|certs?)([/_.-]|$)/i;

// Ordered rules. First match within a path wins for that path; across paths the HIGHEST tier wins (never the last, and
// never an average). T0 rules run first and short-circuit — see the docs note above.
const RULES = [
  // T0 — documentation / non-runtime. Short-circuits: a doc about a trust boundary is still a doc.
  { tier: "T0", re: /\.(md|txt)$/i, why: "documentation / markdown (non-runtime)" },
  { tier: "T0", re: /^docs\//, why: "docs/ tree (non-runtime)" },
  { tier: "T0", re: /(^|\/)LICENSE$/, why: "licence text (non-runtime)" },

  // T3 — trust boundary.
  { tier: "T3", re: /^supabase\/migrations\//, why: "database migration (append-only history; RLS/roles/grants live here)" },
  { tier: "T3", re: /^supabase\/tests\//, why: "RLS / tenant-isolation proof suite" },
  { tier: "T3", re: /^\.github\/workflows\//, why: "CI workflow (can disable or weaken a security gate)" },
  { tier: "T3", re: /(^|\/)deploy\//, why: "deploy/infra template (task role, IAM, secrets wiring)" },
  { tier: "T3", re: T3_WORDS, why: "trust-boundary path (auth/OAuth/OIDC/callback/credential/secret/token/KMS/IAM/vault/RLS/tenant/migration/cert)" },

  // T2 — business workflow / connector behaviour.
  { tier: "T2", re: /^src\/lib\/server\//, why: "server behaviour (connector discovery, sync, normalization, governance computation)" },
  { tier: "T2", re: /^src\/lib\/(canonical|data|customer-connectors|files)\//, why: "canonical/read layer or contract & file handling" },
  { tier: "T2", re: /^src\/app\/api\//, why: "API route (server-side workflow)" },
  { tier: "T2", re: /^src\/lib\//, why: "shared library used by server code" },
  { tier: "T2", re: /^(scripts|runner|contracts)\//, why: "verification script, runner deployable, or cross-repo contract" },
  { tier: "T2", re: /^supabase\//, why: "supabase config/fixture/snippet (non-migration)" },
  { tier: "T2", re: /^(package(-lock)?\.json|Dockerfile|(next|vitest|eslint|postcss|tsconfig)[^/]*)$/, why: "build, dependency, or toolchain configuration" },

  // T1 — low-risk UI / presentation.
  { tier: "T1", re: /^src\/(app|components)\//, why: "UI / presentation surface" },
  { tier: "T1", re: /^public\//, why: "static asset" },
  { tier: "T1", re: /\.css$/i, why: "stylesheet" },
];

const UNCLASSIFIED = { tier: "T2", why: "unclassified path — no deterministic rule matched; classify it semantically" };

function ruleFor(path) {
  return RULES.find((r) => r.re.test(path)) ?? UNCLASSIFIED;
}

/**
 * @param {string[]} paths repo-relative changed paths
 * @returns {{ baselineRiskTier: string, riskReasons: string[] }} — never `riskTier`: the name says "baseline" because
 *   that is all it is. Reasons are grouped per rule (tier desc, then rule order) so a 300-file diff stays readable.
 */
export function classifyChangeRisk(paths) {
  const clean = (Array.isArray(paths) ? paths : [])
    .filter((p) => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim());

  if (clean.length === 0) return { baselineRiskTier: "T0", riskReasons: ["no changed files"] };

  const hits = new Map(); // rule -> matching paths, in first-seen order
  for (const p of clean) {
    const rule = ruleFor(p);
    if (!hits.has(rule)) hits.set(rule, []);
    hits.get(rule).push(p);
  }

  const baselineRiskTier = [...hits.keys()].reduce(
    (hi, r) => (TIERS.indexOf(r.tier) > TIERS.indexOf(hi) ? r.tier : hi),
    "T0",
  );

  const riskReasons = [...hits.entries()]
    .sort((a, b) => TIERS.indexOf(b[0].tier) - TIERS.indexOf(a[0].tier) || RULES.indexOf(a[0]) - RULES.indexOf(b[0]))
    .map(([rule, matched]) => {
      const extra = matched.length > 1 ? ` (+${matched.length - 1} more)` : "";
      return `${rule.tier} · ${rule.why} — ${matched[0]}${extra}`;
    });

  return { baselineRiskTier, riskReasons };
}

// CLI: newline-separated paths on stdin -> two human-readable blocks on stdout. Used by pr-review-summary.sh so the
// tier rules have exactly ONE owner (ENGINEERING_STANDARDS.md §O) instead of being re-expressed in bash.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stdin = await new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf));
  });
  const { baselineRiskTier, riskReasons } = classifyChangeRisk(stdin.split("\n"));
  console.log(`baselineRiskTier : ${baselineRiskTier}`);
  console.log("riskReasons:");
  for (const r of riskReasons) console.log(`    ${r}`);
}
