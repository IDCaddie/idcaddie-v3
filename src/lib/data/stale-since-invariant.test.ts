import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Phase 2.1 — static guard over migration 0070.
//
// Most of this invariant is proved behaviourally in supabase/tests/current_stale_since_invariant_test.sql against a real Postgres. One
// part cannot be: the REPAIR statements. The test harness applies migrations to an empty database, so the repair runs against zero rows
// and its WHERE clause is unobservable there. Widening it to `where stale_since is not null` — which would wipe the timestamp off
// genuinely stale rows and destroy the "last seen" evidence on every stale record in staging — passes the SQL suite untouched.
//
// So the repair's scope is asserted on the migration text, which is the only place the mistake is visible before it has already run.
// The same scan pins the two things the SQL suite does cover, so a reader sees the whole invariant in one place.

const MIGRATIONS = join(__dirname, "../../../supabase/migrations");
const SQL = readFileSync(join(MIGRATIONS, "0070_current_stale_since_invariant.sql"), "utf8");

// The six canonical Okta discovery tables that carry sync_status + stale_since.
const TABLES = [
  "identity_accounts",
  "directory_groups",
  "directory_applications",
  "directory_group_memberships",
  "directory_application_user_assignments",
  "directory_application_group_assignments",
] as const;

const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

describe("migration 0070 — the repair is scoped to current rows only", () => {
  const repairs = statements(SQL).filter((s) => /^update public\.\w+ set stale_since = null/.test(s));

  it("repairs every one of the six tables", () => {
    expect(repairs).toHaveLength(TABLES.length);
    for (const t of TABLES) {
      expect(repairs.some((r) => r.startsWith(`update public.${t} set stale_since = null`)), `${t} must be repaired`).toBe(true);
    }
  });

  it("never clears stale_since on a row that is genuinely stale", () => {
    // THE assertion this file exists for. `stale_since` is the only record of when a row was last seen; nulling it on a stale row
    // destroys evidence irreversibly, and the SQL suite cannot see it because the repair runs on an empty database.
    for (const r of repairs) {
      expect(r, `unscoped repair would erase real stale evidence: ${r}`).toContain("where sync_status = 'current'");
      expect(r).toContain("stale_since is not null");
    }
  });

  it("touches no column other than stale_since", () => {
    // Advancing updated_at would misrepresent a correction of a value that was always wrong as a change to the record.
    for (const r of repairs) {
      const setClause = r.slice(r.indexOf(" set ") + 5, r.indexOf(" where "));
      expect(setClause.trim()).toBe("stale_since = null");
    }
  });
});

describe("migration 0070 — the invariant is enforced in the database", () => {
  it("adds a validated CHECK on all six tables", () => {
    const st = statements(SQL);
    for (const t of TABLES) {
      const add = st.find((s) => s.startsWith(`alter table public.${t} add constraint`) && s.includes("stale_since is null"));
      expect(add, `${t} must gain the invariant CHECK`).toBeTruthy();
      // Only `current` is constrained: stale / review_required / disconnected may all legitimately carry a timestamp.
      expect(add).toContain("check (sync_status <> 'current' or stale_since is null)");
      const constraintName = add!.match(/add constraint (\w+)/)![1];
      expect(
        st.some((s) => s === `alter table public.${t} validate constraint ${constraintName}`),
        `${t}'s CHECK must be VALIDATED — a NOT VALID constraint lets pre-existing bad rows survive`,
      ).toBe(true);
    }
  });
});

describe("migration 0070 — the two broken promote functions are fixed", () => {
  it("clears stale_since when restoring a row to current", () => {
    for (const fn of ["runner_promote_okta_directory_users", "runner_promote_okta_directory_groups"]) {
      const i = SQL.indexOf(`create or replace function public.${fn}(`);
      expect(i, `${fn} must be replaced by 0070`).toBeGreaterThan(-1);
      const body = SQL.slice(i, SQL.indexOf("\n$$;", i));
      expect(body, `${fn} must clear stale_since on re-promotion`).toContain("stale_since = null");
      expect(body).toContain("sync_status = 'current'");
    }
  });

  it("leaves the eligibility gate, supersession guard and connector scoping intact", () => {
    // The fix is one line inside a do-update-set. If a replacement dropped any of these, a promote would accept an incomplete run,
    // a superseded run, or a fact from another connection — far worse than the bug being fixed.
    for (const fn of ["runner_promote_okta_directory_users", "runner_promote_okta_directory_groups"]) {
      const i = SQL.indexOf(`create or replace function public.${fn}(`);
      const body = SQL.slice(i, SQL.indexOf("\n$$;", i));
      expect(body, "completeness gate").toContain("not eligible for promotion");
      expect(body, "supersession guard").toContain("superseded by a later complete run");
      expect(body, "connector scoping").toContain("is not distinct from v_connector_id::text");
      expect(body, "definer + pinned search_path").toContain("security definer set search_path = ''");
      expect(body, "first_seen_at must stay preserved").toContain("first_seen_at intentionally NOT updated");
    }
  });

  it("re-asserts least privilege on both replaced functions", () => {
    for (const sig of ["runner_promote_okta_directory_users(uuid, uuid)", "runner_promote_okta_directory_groups(uuid, uuid)"]) {
      expect(SQL).toContain(`revoke execute on function public.${sig} from public, anon, authenticated;`);
      expect(SQL).toContain(`grant execute on function public.${sig} to connector_runner;`);
    }
  });

  it("changes nothing else — no threshold, gate, trigger or budget is touched", () => {
    for (const forbidden of [
      "stale_percent_threshold", "stale_absolute_threshold", "connector_discovery_policy",   // thresholds
      "circuitBreakerTriggered", "runner_mark_absent",                                       // stale/breaker logic
      "audit_okta_stale_transition", "create trigger", "drop trigger",                       // audit behaviour
      "completeness =", "review_required =",                                                 // completeness gates
      "drop table", "truncate", "delete from",                                               // destructive
    ]) {
      expect(SQL, `0070 must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("migration 0070 — the four already-correct promote paths were left alone", () => {
  it("does not replace the RPCs that already cleared stale_since", () => {
    // 0056/0057/0060 were correct. Re-issuing them would be an unreviewed rewrite of working code.
    for (const fn of [
      "runner_promote_okta_directory_group_memberships",
      "runner_promote_okta_directory_applications",
      "runner_promote_okta_application_user_assignments",
      "runner_promote_okta_application_group_assignments",
    ]) {
      expect(SQL, `${fn} was already correct and must not be reissued`).not.toContain(`function public.${fn}(`);
    }
  });

  it("is not silently undone by a later migration", () => {
    // The first version of this asserted 0070 was the highest-numbered migration, which broke the moment 0071 landed and
    // guarded nothing real. What actually matters: no LATER migration may reissue either promote function without the clear,
    // or drop the CHECK. 0071 legitimately reissues nine OTHER 0061 read RPCs, so the check must be specific, not a blanket ban.
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) > 70)
      .map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")] as const);

    for (const [name, sql] of later) {
      for (const fn of ["runner_promote_okta_directory_users", "runner_promote_okta_directory_groups"]) {
        const i = sql.indexOf(`create or replace function public.${fn}(`);
        if (i === -1) continue;                       // not reissued here — fine
        const body = sql.slice(i, sql.indexOf("\n$$;", i));
        expect(body, `${name} reissues ${fn} without clearing stale_since`).toContain("stale_since = null");
      }
      expect(sql, `${name} must not drop the invariant CHECK`).not.toMatch(/drop constraint \w*current_no_stale_since/);
    }
  });
});
