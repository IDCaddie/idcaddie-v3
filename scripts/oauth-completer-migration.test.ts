// Static guard over migration 0079.
//
// Three properties of that migration cannot be tested against a database in this repo, and each is load-bearing:
//
//  1. GRANTS. `scripts/test-rls.sh` blanket-grants EXECUTE on all public functions to authenticated/service_role after
//     migrations run, then re-revokes named sets. That masking means a migration which broadened a grant to
//     `authenticated` still produces a green SQL suite — mutation-testing confirmed exactly that.
//  2. THE PROVIDER AND PURPOSE PINS. `connector_app_secrets` constrains both columns to a single value
//     (0035: provider='slack', secret_kind='oauth_client_secret'), so removing either pin from the wrapper's WHERE is
//     unobservable in data. They are defence in depth over those constraints, and defence in depth still has to exist.
//  3. NO PLAINTEXT PARAMETER. Asserted here as well as in SQL so the intent is visible where the code is read.
//
// Reading the migration text is the honest way to assert all three.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("supabase/migrations/0079_oauth_completer_narrow_identity.sql", "utf8");
// §5 grants the three wrappers; §6 separately RE-grants nine pre-existing RLS predicate helpers to anon/authenticated/
// service_role after removing their implicit PUBLIC grant. Only §5 describes this role's surface, so the grant
// assertions are scoped to it — otherwise they would flag a grant that deliberately changes nothing for anyone.
const WRAPPER_GRANT_BLOCK = SRC.slice(SRC.indexOf("-- ══ 5."), SRC.indexOf("-- ══ 6."));
const WRAPPERS = [
  "oauth_completer_read_app_client_secret_envelope",
  "oauth_completer_consume_oauth_pending",
  "oauth_completer_store_connector_secret_envelope",
] as const;

describe("0079 — the granted surface", () => {
  it("grants EXECUTE to oauth_completer and to no other role", () => {
    const grants = [...WRAPPER_GRANT_BLOCK.matchAll(/grant execute on function[^;]*?to ([a-z_, ]+)'/g)].map((m) => m[1].trim());
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g, `unexpected grantee in 0079: ${g}`).toBe("oauth_completer");
  });

  it("revokes EXECUTE from every named Supabase role, not just PUBLIC", () => {
    // ALTER DEFAULT PRIVILEGES hands new public functions to anon/authenticated/service_role on hosted Supabase (0045),
    // and `revoke from public` alone does not remove that. connector_runner is named too: it has its own path.
    const revoke = WRAPPER_GRANT_BLOCK.match(/revoke execute on function %s from ([a-z_, ]+)'/);
    expect(revoke, "0079 must revoke EXECUTE on the wrappers").not.toBeNull();
    for (const role of ["public", "anon", "authenticated", "service_role", "connector_runner"]) {
      expect(revoke![1], `0079 must name ${role} in the wrapper revoke`).toContain(role);
    }
  });

  it("exposes exactly three wrappers", () => {
    const created = [...SRC.matchAll(/create or replace function public\.(oauth_completer_[a-z_]+)\(/g)].map((m) => m[1]);
    expect([...new Set(created)].sort()).toEqual([...WRAPPERS].sort());
  });
});

describe("0079 — wrapper hardening", () => {
  it.each(WRAPPERS)("%s is security definer with an EMPTY pinned search_path", (name) => {
    const body = SRC.slice(SRC.indexOf(`create or replace function public.${name}(`));
    const head = body.slice(0, body.indexOf("$$"));
    expect(head).toMatch(/security definer/);
    // `set search_path = ''` — not `= public`, which would still let an unqualified name resolve somewhere.
    expect(head).toMatch(/set search_path = ''/);
  });

  it("pins provider and purpose rather than accepting them as parameters", () => {
    const read = SRC.slice(SRC.indexOf("function public.oauth_completer_read_app_client_secret_envelope("),
                           SRC.indexOf("-- ══ 3."));
    expect(read).toMatch(/s\.provider = 'slack'/);
    expect(read).toMatch(/s\.secret_kind = 'oauth_client_secret'/);

    const store = SRC.slice(SRC.indexOf("function public.oauth_completer_store_connector_secret_envelope("),
                            SRC.indexOf("-- ══ 5."));
    expect(store).toMatch(/'oauth_access'/);
    expect(store).toMatch(/c\.provider = 'slack'/);

    const consume = SRC.slice(SRC.indexOf("function public.oauth_completer_consume_oauth_pending("),
                              SRC.indexOf("-- ══ 4."));
    expect(consume).toMatch(/p\.provider = 'slack'/);
    // Replay and expiry are part of the same WHERE and must not be separable from it.
    expect(consume).toMatch(/p\.consumed_at is null/);
    expect(consume).toMatch(/p\.expires_at > p_now/);
  });

  it("takes no plaintext parameter of any kind", () => {
    const params = [...SRC.matchAll(/^\s*(p_[a-z_]+)\s+[a-z\[\]]+,?$/gm)].map((m) => m[1]);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) expect(p).not.toMatch(/plaintext|token|client_secret|password|secret_value/);
  });

  it("uses no dynamic SQL inside a wrapper body", () => {
    // `format(...)`/`execute` appear in the migration's grant loops, which is fine; a WRAPPER body must not build SQL.
    for (const name of WRAPPERS) {
      const start = SRC.indexOf(`create or replace function public.${name}(`);
      const body = SRC.slice(start, SRC.indexOf("end $$;", start));
      expect(body, `${name} must not build SQL dynamically`).not.toMatch(/\bexecute\s+format\b|\bexecute\s+'/);
    }
  });

  it("creates the role with every restrictive attribute and no password", () => {
    expect(SRC).toMatch(/create role oauth_completer with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls/);
    // A password in a migration is a password in the repository, the diff and the PR.
    expect(SRC).not.toMatch(/password\s+'/i);
    expect(SRC).not.toMatch(/encrypted password/i);
  });
});

// ── 0080: the caller owns the version, and ordering is the safety property ──────────────────────────────────────
describe("0080 — caller-supplied envelope version", () => {
  const SRC80 = readFileSync("supabase/migrations/0080_connector_secret_caller_version.sql", "utf8");
  const STORE = SRC80.slice(SRC80.indexOf("create or replace function public.oauth_completer_store_connector_secret_envelope("));

  it("stores the caller's version verbatim, never a derived one", () => {
    expect(STORE).toMatch(/'oauth_access', p_version, true, p_ciphertext/);
    // The insert must not recompute the number the caller already sealed into the AAD.
    const insert = STORE.slice(STORE.indexOf("insert into public.connector_secrets"), STORE.indexOf("returning id into v_id"));
    expect(insert).not.toMatch(/max\(/);
  });

  it("supersedes ONLY after the insert has succeeded", () => {
    // Not reachable behaviourally: every failure path raises before the supersede, and forcing a failure AT the insert
    // needs real concurrency. Asserted on the source instead, because the ordering is the whole reason a failed store
    // cannot disarm a working credential.
    const insertAt = STORE.indexOf("insert into public.connector_secrets");
    const supersedeAt = STORE.indexOf("set is_active = false");
    expect(insertAt).toBeGreaterThan(-1);
    expect(supersedeAt).toBeGreaterThan(-1);
    expect(supersedeAt, "the supersede must come after the insert").toBeGreaterThan(insertAt);
  });

  it("drops the version-deriving store rather than leaving it beside the new one", () => {
    expect(SRC80).toMatch(/drop function if exists public\.oauth_completer_store_connector_secret_envelope\(\s*uuid, uuid, bytea/);
  });

  it("enforces version uniqueness in the database, not only in the wrapper", () => {
    expect(SRC80).toMatch(/create unique index[^;]*connector_secrets \(tenant_id, connector_id, secret_kind, version\)/);
  });

  it("grants the new functions to oauth_completer and to no other role", () => {
    const block = SRC80.slice(SRC80.indexOf("-- ══ 4. LEAST PRIVILEGE"));
    const grants = [...block.matchAll(/grant execute on function[^;]*?to ([a-z_, ]+)'/g)].map((m) => m[1].trim());
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).toBe("oauth_completer");
    const revoke = block.match(/revoke execute on function %s from ([a-z_, ]+)'/);
    for (const role of ["public", "anon", "authenticated", "service_role", "connector_runner"]) {
      expect(revoke![1]).toContain(role);
    }
  });
});
