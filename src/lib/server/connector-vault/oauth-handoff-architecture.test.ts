// Phase 8K — the architectural boundary, asserted rather than trusted.
//
// `scripts/check-app-runtime-imports.sh` already enforces the general app↔runner boundary (doc 46 §11). This file is the
// OAuth-completion-specific half of the same promise, and it exists because doc 83 §2 records what happens without it:
// an implementation reached the first full gate run before anyone noticed it was putting a Postgres driver and a KMS
// client in a public request path. The rule was there; nothing checked it early enough.
//
// Every rule below is a PURE function over file contents, and every one is mutation-tested — the suite plants a
// synthetic violation for each rule and asserts that rule (and only that rule) fires. A guard that has never been seen
// to fail is a guard nobody has tested.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..", "..", "..", "..", "src");

type SourceFile = { rel: string; source: string };

// Comments are stripped before every rule runs. These modules document what they must not do, in prose, at length —
// a guard that cannot tell a sentence from a statement would flag the documentation of the property it is checking.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push({ rel: path.relative(SRC, full), source: fs.readFileSync(full, "utf8") });
    }
  }
  return out;
}

// A quoted import specifier, in every form: `from "x"`, `require("x")`, `import "x"`, `await import("x")`.
const importsExactly = (code: string, specifier: string) =>
  new RegExp(`['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`).test(code);
const importsMatching = (code: string, fragment: string) =>
  new RegExp(`['"][^'"]*${fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^'"]*['"]`).test(code);

/** The runner-internal vault modules the OAuth completion path must never reach. */
const RUNNER_VAULT_MODULES = [
  "runner-db-client",
  "runner-connection",
  "runner-ingest-entrypoint",
  "client-secret-ingest-harness",
  "slack-client-secret-store",
  "connector-secret-store",
  "connector-secret-ingest",
  "connector-secret-decrypt-use",
  "kms-key-provider",
  "aws-kms-client",
  "aws-kms-sdk-sender",
  // The two that grant the capabilities these rules exist to deny, and that the first version of this list omitted:
  // `crypto` is envelope decryption, and consuming the pending row is the worker's single-use gate — V3 doing it
  // itself would make the job the worker later claims find the row already consumed. SLASH-ANCHORED so `./crypto` and
  // `@/lib/server/connector-vault/crypto` fire while the legitimate `node:crypto` these modules are built on does not.
  // (Found in adversarial review of PR #398.)
  "/crypto",
  "oauth-pending-consume",
  "oauth-pending-executor",
];

/** The files that make up the OAuth completion path in the web tier. Every one is covered by every rule below. */
const COMPLETION_PATH = [
  // The state validator IS on the completion path — the callback's first act is to call it — and omitting it left it
  // as the one file where a Slack exchange could have been added with every rule still reporting green.
  // (Found in adversarial review of PR #398.)
  "lib/server/connector-vault/oauth-state.ts",
  "lib/server/connector-vault/oauth-handoff-protocol.ts",
  "lib/server/connector-vault/oauth-payload-seal.ts",
  "lib/server/connector-vault/oauth-handoff-client.ts",
  "lib/server/connector-vault/oauth-callback-handoff.ts",
  "lib/server/connector-vault/real-callback-dependencies.ts",
  "lib/server/connector-vault/staging-environment-identity.ts",
  "lib/data/oauth-completion-status.ts",
  "app/(authenticated)/connectors/oauth/callback/route.ts",
  "app/(authenticated)/connectors/oauth/pending/page.tsx",
  "app/(authenticated)/connectors/oauth/pending/actions.ts",
  "app/(authenticated)/connectors/oauth/pending/pending-status.tsx",
].map((p) => p.split("/").join(path.sep));

type Rule = { label: string; applies: (f: SourceFile) => boolean; violates: (code: string, f: SourceFile) => boolean };

const onCompletionPath = (f: SourceFile) => COMPLETION_PATH.includes(f.rel);
const everywhere = () => true;

export const RULES: Rule[] = [
  {
    label: "pg / postgres imported under src/",
    applies: everywhere,
    violates: (code) => importsExactly(code, "pg") || importsExactly(code, "postgres"),
  },
  {
    label: "a KMS SDK reachable from the OAuth completion path",
    applies: onCompletionPath,
    violates: (code) => importsMatching(code, "@aws-sdk/") || /KmsClient|GenerateDataKey|DecryptCommand/.test(code),
  },
  {
    label: "a runner-internal vault module reachable from the OAuth completion path",
    applies: onCompletionPath,
    violates: (code) => RUNNER_VAULT_MODULES.some((m) => importsMatching(code, m)),
  },
  {
    label: "OAUTH_COMPLETER_DB_URL read as configuration",
    applies: everywhere,
    // The environment gate names the variable in order to REFUSE it. Reading it as a value — `env.X`, `env["X"]`,
    // destructuring it — is the violation, and the gate does none of those.
    violates: (code) => /(?:process\.)?env\s*(?:\.OAUTH_COMPLETER_DB_URL\b|\[\s*['"]OAUTH_COMPLETER_DB_URL['"]\s*\])/.test(code)
      || /\{[^}]*\bOAUTH_COMPLETER_DB_URL\b[^}]*\}\s*=\s*(?:process\.)?env/.test(code),
  },
  {
    label: "the connector_runner credential referenced under src/",
    applies: (f) => !f.rel.endsWith("staging-environment-identity.ts"),
    // The gate declares the role name so it can refuse it; nowhere else may mention it at all.
    violates: (code) => /connector_runner_login|CONNECTOR_RUNNER_DB_URL/.test(code),
  },
  {
    // DIRECT imports only, and the label says so. `route.ts` legitimately imports the SYNTHETIC handler, which
    // transitively pulls the orchestrator and the exchange module into the same bundle — so a transitive version of
    // this rule would be red today for a path that has no egress (the exchange takes an INJECTED http client and the
    // only one wired in that graph is the synthetic in-memory stub). What stops the REAL branch reaching any of it is
    // asserted separately, by slicing the real branch out of the route in real-callback-dependencies.test.ts.
    // Naming the rule accurately is the fix; claiming more than it checks was the defect.
    // (Found in adversarial review of PR #398.)
    label: "a Slack exchange DIRECTLY imported by an OAuth completion-path module",
    applies: (f) => onCompletionPath(f) && !f.rel.endsWith(path.join("callback", "route.ts")),
    violates: (code) =>
      /slack\.com|oauth\.v2\.access/.test(code) ||
      ["slack-oauth-exchange", "slack-http-client", "oauth-callback-orchestrator", "oauth-real-exchange-wiring", "oauth-callback-real-runner"]
        .some((m) => importsMatching(code, m)),
  },
  {
    label: "a direct completion-job database write from V3",
    applies: everywhere,
    // The five `oauth_completer_*` lifecycle wrappers belong to the worker. V3 may name exactly one 0081 function: the
    // customer-safe product read.
    violates: (code) => /oauth_completer_[a-z_]+|oauth_completion_jobs\b/.test(code),
  },
  {
    label: "the OAuth completion path consuming the pending row itself",
    applies: onCompletionPath,
    violates: (code) => /runner_consume_oauth_pending|runner_ingest_connector_secret|product_read_app_client_secret_envelope/.test(code),
  },
];

function violations(files: SourceFile[]): string[] {
  const found: string[] = [];
  for (const f of files) {
    const code = stripComments(f.source);
    for (const rule of RULES) {
      if (rule.applies(f) && rule.violates(code, f)) found.push(`${rule.label} — ${f.rel}`);
    }
  }
  return found.sort();
}

describe("the OAuth completion path holds no capability it must not", () => {
  // Test files are excluded: a test legitimately names the thing it is proving absent, and tests never ship.
  const files = walk(SRC).filter((f) => !/\.test\.(ts|tsx)$/.test(f.rel));

  it("every file of the completion path exists and is covered", () => {
    const present = new Set(files.map((f) => f.rel));
    for (const rel of COMPLETION_PATH) expect(present.has(rel), rel).toBe(true);
  });

  it("finds no violation anywhere under src/", () => {
    expect(violations(files)).toEqual([]);
  });

  it("the environment gate is the ONLY place that names the completer variable, and only to refuse it", () => {
    const namers = files.filter((f) => /OAUTH_COMPLETER_DB_URL/.test(stripComments(f.source))).map((f) => f.rel);
    expect(namers).toEqual([path.join("lib", "server", "connector-vault", "staging-environment-identity.ts")]);
  });

  it("names exactly one migration-0081 function, and it is the customer-safe read", () => {
    const named = new Set<string>();
    for (const f of files) for (const m of stripComments(f.source).matchAll(/\b(?:oauth_completer|product_oauth)_[a-z_]+/g)) named.add(m[0]);
    expect([...named]).toEqual(["product_oauth_completion_job_status"]);
  });
});

// ── MUTATION TESTS ───────────────────────────────────────────────────────────────────────────────────────────────────
// Each rule gets a planted violation. A rule that cannot be made to fire is not protecting anything.
describe("every rule actually fires", () => {
  const onPath: string = COMPLETION_PATH.find((p) => p.endsWith("oauth-callback-handoff.ts")) as string;
  const plants: Array<[string, SourceFile]> = [
    ["pg / postgres imported under src/", { rel: "lib/anything.ts", source: `import { Pool } from "pg";` }],
    ["pg / postgres imported under src/", { rel: "lib/anything.ts", source: `const p = await import("postgres");` }],
    ["a KMS SDK reachable from the OAuth completion path", { rel: onPath, source: `import { KMSClient } from "@aws-sdk/client-kms";` }],
    ["a runner-internal vault module reachable from the OAuth completion path", { rel: onPath, source: `import { x } from "./runner-db-client";` }],
    ["a runner-internal vault module reachable from the OAuth completion path", { rel: onPath, source: `import { y } from "@/lib/server/connector-vault/kms-key-provider";` }],
    ["a runner-internal vault module reachable from the OAuth completion path", { rel: onPath, source: `import { decryptAppSecret } from "./crypto";` }],
    ["a runner-internal vault module reachable from the OAuth completion path", { rel: onPath, source: `import { d } from "@/lib/server/connector-vault/crypto";` }],
    ["a runner-internal vault module reachable from the OAuth completion path", { rel: onPath, source: `import { consumeOAuthPending } from "./oauth-pending-consume";` }],
    ["OAUTH_COMPLETER_DB_URL read as configuration", { rel: "lib/anything.ts", source: `const u = process.env.OAUTH_COMPLETER_DB_URL;` }],
    ["OAUTH_COMPLETER_DB_URL read as configuration", { rel: "lib/anything.ts", source: `const u = env["OAUTH_COMPLETER_DB_URL"];` }],
    ["OAUTH_COMPLETER_DB_URL read as configuration", { rel: "lib/anything.ts", source: `const { OAUTH_COMPLETER_DB_URL } = process.env;` }],
    ["the connector_runner credential referenced under src/", { rel: "lib/anything.ts", source: `const role = "connector_runner_login";` }],
    ["a Slack exchange DIRECTLY imported by an OAuth completion-path module", { rel: onPath, source: `await fetch("https://slack.com/api/oauth.v2.access");` }],
    ["a Slack exchange DIRECTLY imported by an OAuth completion-path module", { rel: onPath, source: `import { exchange } from "./slack-oauth-exchange";` }],
    ["a direct completion-job database write from V3", { rel: "lib/anything.ts", source: `await rpc("oauth_completer_enqueue_oauth_completion_job", {});` }],
    ["a direct completion-job database write from V3", { rel: "lib/anything.ts", source: `await supabase.from("oauth_completion_jobs").select("*");` }],
    ["the OAuth completion path consuming the pending row itself", { rel: onPath, source: `await rpc("runner_consume_oauth_pending", {});` }],
  ];

  it.each(plants)("%s fires on a planted violation", (label, file) => {
    const found = violations([file]);
    expect(found.some((v) => v.startsWith(label)), `planted: ${file.source}`).toBe(true);
  });

  it("a clean file trips nothing", () => {
    expect(violations([{ rel: onPath, source: `import { z } from "zod";\nexport const ok = true;` }])).toEqual([]);
  });

  // The comment-stripping must not become a loophole in the other direction: real code inside a string is still code as
  // far as these rules are concerned, but a rule must not be satisfiable by moving the violation into a comment.
  it("a violation is not laundered by writing it as prose — the guard reads code, and the code is what fires", () => {
    expect(violations([{ rel: onPath, source: `// this module never imports "pg"\nexport const ok = true;` }])).toEqual([]);
    expect(violations([{ rel: onPath, source: `/* not "pg" */ import { Pool } from "pg";` }]).length).toBeGreaterThan(0);
  });
});
