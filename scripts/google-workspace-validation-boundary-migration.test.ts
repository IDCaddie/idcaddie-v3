// Static guard over migration 0092 — the Google Workspace validation boundary.
//
// WHY A STATIC TEST EXISTS AT ALL. `scripts/test-rls.sh` blanket-grants on every table and every function after
// migrations run, then re-revokes a named set. That masking means a migration which handed this function to
// `authenticated`, or this table to any browser role, still produces a GREEN SQL suite — the same masking class
// documented for 0016, 0076, 0085 and 0079. The pgTAP suite's G0 is the runtime backstop; this file is the guard on the
// migration TEXT, which is the only place the hosted truth is actually written.
//
// It also pins the two properties that are invisible at runtime because they are about what the migration does NOT do:
// it must not widen 0052's transition allowlist, and it must not touch an Okta object.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const PATH = "supabase/migrations/0092_google_workspace_connector_validation.sql";
const SRC = readFileSync(PATH, "utf8");

// Comments would otherwise satisfy a naive `toContain` and, worse, a `grant` inside one would not be flagged.
const CODE = SRC.split("\n").filter(l => !l.trimStart().startsWith("--")).join("\n");

const TABLE = "google_workspace_connector_validations";
const FN = "runner_record_google_workspace_validation";
const SIG = "\\(uuid, uuid, uuid, text, text, text, text, text, text\\)";

describe("0092 — the recording command is runner-only", () => {
  it.each(["public", "anon", "authenticated", "service_role"])(
    "revokes execute from %s by name (a PUBLIC revoke alone leaves Supabase's explicit grantees intact)",
    role => {
      expect(CODE).toMatch(new RegExp(`revoke all on function public\\.${FN}${SIG} from ${role};`, "i"));
    },
  );

  it("grants execute to connector_runner and to nobody else", () => {
    expect(CODE).toMatch(new RegExp(`grant execute on function public\\.${FN}${SIG} to connector_runner;`, "i"));
    const grants = CODE.match(new RegExp(`grant execute on function public\\.${FN}[\\s\\S]*?;`, "gi")) ?? [];
    expect(grants).toHaveLength(1);
    // Check the GRANTEE list only — `public.` in the qualified function name is a schema, not a role.
    for (const g of grants) {
      const grantees = g.slice(g.lastIndexOf(" to ") + 4).replace(";", "").split(",").map(r => r.trim());
      expect(grantees).toEqual(["connector_runner"]);
    }
  });
});

describe("0092 — the evidence table is deny-all", () => {
  it("enables RLS and revokes every request-path role AND the runner", () => {
    expect(CODE).toMatch(new RegExp(`alter table public\\.${TABLE} enable row level security;`, "i"));
    expect(CODE).toMatch(new RegExp(`revoke all on public\\.${TABLE} from public, anon, authenticated, connector_runner;`, "i"));
  });

  it("grants no table privilege on it to any role — the definer function is the only way in", () => {
    expect(CODE).not.toMatch(new RegExp(`grant\\s+[\\s\\S]{0,80}?\\son\\s+(table\\s+)?public\\.${TABLE}\\b`, "i"));
  });

  it("adds no policy, so PostgREST can serve no row of it", () => {
    expect(CODE).not.toMatch(new RegExp(`create\\s+policy[\\s\\S]{0,200}?on\\s+public\\.${TABLE}\\b`, "i"));
  });

  it("is re-revoked in the RLS harness, in lockstep, or the blanket grant would mask the posture", () => {
    const harness = readFileSync("scripts/test-rls.sh", "utf8");
    expect(harness).toMatch(new RegExp(`revoke all on public\\.${TABLE} from anon, authenticated, connector_runner;`, "i"));
  });
});

describe("0092 — verified stays EARNED", () => {
  it("is the only place that writes connection_state = 'verified' for this provider", () => {
    expect(CODE).toMatch(/update public\.connectors set connection_state = 'verified'/i);
  });

  it("does not widen 0052's transition allowlist", () => {
    // If ('configured','verified') were ever added to runner_advance_connection_state, this function would stop being
    // the only route and every guard in it could be walked around by the generic state machine.
    expect(CODE).not.toMatch(/runner_advance_connection_state/i);
    const lifecycle = readFileSync("supabase/migrations/0052_connector_discovery_lifecycle.sql", "utf8");
    expect(lifecycle).not.toMatch(/\(\s*'configured'\s*,\s*'verified'\s*\)/);
    // and no later migration may add it either
    for (const f of readdirSync("supabase/migrations").filter(f => f.endsWith(".sql"))) {
      const body = readFileSync(`supabase/migrations/${f}`, "utf8")
        .split("\n").filter(l => !l.trimStart().startsWith("--")).join("\n");
      if (!/runner_advance_connection_state/i.test(body)) continue;
      expect(body, `${f} must not authorize configured -> verified`).not.toMatch(/\(\s*'configured'\s*,\s*'verified'\s*\)/);
    }
  });

  it("gates the transition on the configured start state", () => {
    expect(CODE).toMatch(/connection_state is not configured/i);
  });

  it("requires the full evidence package for a success, in both directions", () => {
    expect(CODE).toMatch(/google_workspace_validation_success_requires_evidence_chk/);
    expect(CODE).toMatch(/google_workspace_validation_evidence_requires_success_chk/);
  });

  it("pins the contract version rather than trusting the caller", () => {
    expect(CODE).toMatch(/c_contract constant text := '1\.0\.0'/);
  });
});

describe("0092 — blast radius", () => {
  it("touches no Okta object", () => {
    expect(CODE).not.toMatch(/okta/i);
  });

  it("touches no 0086 write-path object", () => {
    for (const fn of ["runner_promote_directory_", "runner_mark_absent_directory_", "runner_insert_discovery_fact",
                      "runner_record_directory_discovery_metrics", "runner_assert_parameterized_provider"]) {
      expect(CODE).not.toMatch(new RegExp(fn, "i"));
    }
  });

  it("is additive: no drop, no truncate, no delete, no column removal on an existing table", () => {
    expect(CODE).not.toMatch(/\bdrop\s+(table|constraint|policy|column|index)\b/i);
    expect(CODE).not.toMatch(/\btruncate\b/i);
    expect(CODE).not.toMatch(/\bdelete\s+from\b/i);
    // the only ALTER TABLE is on the table this migration creates
    for (const m of CODE.match(/alter table\s+(public\.)?(\w+)/gi) ?? []) {
      expect(m.toLowerCase()).toContain(TABLE);
    }
  });

  it("activates nothing: no status flip, no schedule, no sync authorization", () => {
    expect(CODE).not.toMatch(/set\s+status\s*=\s*'active'/i);
    expect(CODE).not.toMatch(/sync_authorized|connected_unsynced|schedule/i);
  });
});
