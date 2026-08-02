// Static guard over migrations 0079, 0080 and 0081 — the `oauth_completer` surface. Each migration's own block below
// records what it needs from this file; the reasons are the same three every time.
//
// Three properties of 0079 cannot be tested against a database in this repo, and each is load-bearing:
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

// ── 0081: the completion job — one claim, one terminal transition, nothing left holding a sealed code ───────────
//
// Four properties here cannot be seen from the SQL suite, and each is load-bearing:
//
//  1. GRANTS, for the reason at the top of this file — `scripts/test-rls.sh` blanket-grants and then re-revokes, so a
//     migration that broadened a grant still produces a green SQL suite.
//  2. THE CLAIM IS ONE STATEMENT. A `select` that decides followed by an `update` that acts behaves identically in a
//     single-session test and races in production. "There is no read between deciding and writing" is a property of
//     the TEXT, not of any observable result.
//  3. THE PAYLOAD IS CLEARED BY THE SAME STATEMENT THAT GOES TERMINAL. Clearing it in a second UPDATE passes every
//     assertion in the suite and leaves a window in which a terminal row still holds a sealed authorization code.
//  4. THE CLOCK. Every wrapper reads `now()` itself; a `timestamptz` parameter would let the caller choose the
//     deadline, and a caller that chooses the deadline defeats "short-lived" without failing a single test.
describe("0081 — the OAuth completion job", () => {
  const SRC81 = readFileSync("supabase/migrations/0081_oauth_completion_jobs.sql", "utf8");

  const COMPLETER_WRAPPERS = [
    "oauth_completer_enqueue_oauth_completion_job",
    "oauth_completer_claim_oauth_completion_job",
    "oauth_completer_complete_oauth_completion_job",
    "oauth_completer_fail_oauth_completion_job",
    "oauth_completer_expire_oauth_completion_jobs",
  ] as const;
  const PRODUCT_READ = "product_oauth_completion_job_status";

  /** The whole body of one wrapper, from its signature to its terminating `end $$;`. */
  const fn = (name: string) => {
    const start = SRC81.indexOf(`create or replace function public.${name}(`);
    expect(start, `${name} must exist in 0081`).toBeGreaterThan(-1);
    return SRC81.slice(start, SRC81.indexOf("end $$;", start));
  };
  /** Just the signature — parameters and return type. */
  const head = (name: string) => {
    const b = fn(name);
    return b.slice(0, b.indexOf("language plpgsql"));
  };
  /** The PARAMETER list alone. Deliberately excludes the return type: a `timestamptz` a wrapper RETURNS is a deadline
   *  it computed, while a `timestamptz` it ACCEPTS is a deadline the caller chose. */
  const params = (name: string) => {
    const sig = head(name);
    return sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(") returns"));
  };
  /** The first `update public.oauth_completion_jobs …` statement in a wrapper, up to its terminating semicolon. */
  const firstUpdate = (name: string) => {
    const b = fn(name);
    const at = b.indexOf("update public.oauth_completion_jobs");
    expect(at, `${name} must update the job table`).toBeGreaterThan(-1);
    return b.slice(at, b.indexOf(";", at));
  };

  const GRANT_BLOCK = SRC81.slice(SRC81.indexOf("-- ══ 9. LEAST PRIVILEGE"));

  it("grants the completion wrappers to oauth_completer and to no other role", () => {
    const loop = GRANT_BLOCK.slice(0, GRANT_BLOCK.indexOf("revoke execute on function public.product_"));
    const grants = [...loop.matchAll(/grant execute on function[^;]*?to ([a-z_, ]+)'/g)].map((m) => m[1].trim());
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g, `unexpected grantee in 0081: ${g}`).toBe("oauth_completer");

    const revoke = loop.match(/revoke execute on function %s from ([a-z_, ]+)'/);
    expect(revoke, "0081 must revoke EXECUTE on the wrappers").not.toBeNull();
    for (const role of ["public", "anon", "authenticated", "service_role", "connector_runner"]) {
      expect(revoke![1], `0081 must name ${role} in the wrapper revoke`).toContain(role);
    }

    // Named one by one, so a wrapper cannot be added to the file and left ungranted — or granted and left off the loop.
    for (const w of COMPLETER_WRAPPERS) expect(loop, `${w} must be in the grant loop`).toContain(`public.${w}(`);
  });

  it("grants the customer read to authenticated only, and never to the identity that works the job", () => {
    const line = GRANT_BLOCK.slice(GRANT_BLOCK.indexOf(`revoke execute on function public.${PRODUCT_READ}`));
    // `oauth_completer` is the one that matters: 0079's blanket revoke loop ran before this function existed, and the
    // PUBLIC grant Postgres creates with every function would otherwise hand it over.
    for (const role of ["public", "anon", "service_role", "connector_runner", "oauth_completer"]) {
      expect(line, `0081 must revoke ${PRODUCT_READ} from ${role}`).toMatch(
        new RegExp(`from[^;]*\\b${role}\\b`, "s"),
      );
    }
    const granted = line.match(new RegExp(`grant execute on function public\\.${PRODUCT_READ}\\([^)]*\\) to ([a-z_, ]+);`));
    expect(granted, "the customer read must be granted").not.toBeNull();
    expect(granted![1].trim()).toBe("authenticated");
  });

  it("claims with ONE atomic UPDATE — nothing reads the row before it is written", () => {
    const body = fn("oauth_completer_claim_oauth_completion_job");
    const preamble = body.slice(body.indexOf("\nbegin"), body.indexOf("update public.oauth_completion_jobs"));
    expect(preamble, "the claim must not read the row before updating it").not.toMatch(/\bselect\b/i);
    expect(body, "the claim must not need row locking — the UPDATE's own predicate is the lock").not.toMatch(/for update/i);

    // Both gates in the SAME predicate. Either one moved to a preceding statement is a claim whose safety depends on
    // something else having run first.
    const claim = firstUpdate("oauth_completer_claim_oauth_completion_job");
    expect(claim).toMatch(/set status = 'claimed'/);
    expect(claim, "only a pending job may be claimed").toMatch(/j\.status = 'pending'/);
    expect(claim, "only an unexpired job may be claimed").toMatch(/j\.expires_at > v_now/);
    expect(claim, "the claim is bound to tenant, connector and provider").toMatch(/j\.tenant_id = p_tenant_id/);
    expect(claim).toMatch(/j\.connector_id = p_connector_id/);
    expect(claim).toMatch(/j\.provider = 'slack'/);
    expect(claim, "the attempt is counted on the claim itself").toMatch(/attempt_count = j\.attempt_count \+ 1/);
  });

  it.each(["complete", "fail"] as const)(
    "%s transitions only from claimed, and clears the sealed payload in the same statement",
    (verb) => {
      const stmt = firstUpdate(`oauth_completer_${verb}_oauth_completion_job`);
      expect(stmt, "a job that was never claimed must not be resolvable").toMatch(/j\.status = 'claimed'/);
      // Same statement, not a follow-up UPDATE: a second statement leaves a window where a terminal row still holds it.
      for (const col of ["protected_payload", "payload_scheme", "payload_key_id"]) {
        expect(stmt, `${verb} must null ${col} as it goes terminal`).toMatch(new RegExp(`${col} = null`));
      }
      expect(stmt).toMatch(/j\.tenant_id = p_tenant_id/);
      expect(stmt).toMatch(/j\.connector_id = p_connector_id/);
    },
  );

  it("only the deadline may declare a job expired", () => {
    const body = fn("oauth_completer_fail_oauth_completion_job");
    const accepted = body.slice(body.indexOf("p_terminal_reason not in"), body.indexOf("raise exception"));
    expect(accepted).toContain("exchange_failed");
    expect(accepted, "'expired' must not be a reason a caller can supply").not.toContain("'expired'");
  });

  it("the expiry sweep clears the sealed code of a stale claim without stealing its terminal transition", () => {
    const body = fn("oauth_completer_expire_oauth_completion_jobs");
    const statements = body.split("update public.oauth_completion_jobs").slice(1);
    expect(statements.length, "the sweep does two distinct things").toBe(2);
    expect(statements[0], "pending past its deadline becomes expired").toMatch(/set status = 'expired'/);
    expect(statements[0]).toMatch(/j\.status = 'pending'/);
    // The second must clear the payload and MUST NOT set a status: a claimed job's terminal transition is its worker's.
    expect(statements[1]).toMatch(/j\.status = 'claimed'/);
    expect(statements[1], "a stale claim must not be expired underneath its worker").not.toMatch(/set status/);
    expect(statements[1]).toMatch(/protected_payload = null/);
  });

  it("keys enqueue idempotency on the SEALED BYTES, not on the fields the lookup already pinned", () => {
    // The 0080 lesson, one layer up: a digest over (tenant, connector, provider, redirect, workspace, correlation) is a
    // tautology under a correlation lookup, and a SUBSTITUTED authorization code would compare equal to the original.
    const body = fn("oauth_completer_enqueue_oauth_completion_job");
    const digest = body.slice(body.indexOf("v_digest := "), body.indexOf("'hex');") + 7);
    expect(digest).toMatch(/sha256\(/);
    expect(digest, "the digest must cover the sealed payload").toContain("p_protected_payload");
    expect(digest).toContain("p_correlation_id");
    // The caller does not get to supply it.
    expect(head("oauth_completer_enqueue_oauth_completion_job")).not.toMatch(/p_body_digest/);
  });

  it("takes no clock from the caller — every wrapper reads now() itself", () => {
    for (const name of [...COMPLETER_WRAPPERS, PRODUCT_READ]) {
      expect(params(name), `${name} must not accept a caller-supplied time`).not.toMatch(/timestamptz/);
    }
    for (const name of COMPLETER_WRAPPERS) {
      // Except the sweep-free product read, every mutating wrapper stamps from the database clock.
      expect(fn(name), `${name} must read the database clock`).toMatch(/now\(\)/);
    }
  });

  it("exposes exactly five completion wrappers and one customer read", () => {
    const created = [...SRC81.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
    expect([...new Set(created)].sort()).toEqual([...COMPLETER_WRAPPERS, PRODUCT_READ].sort());
  });

  it.each([...COMPLETER_WRAPPERS, PRODUCT_READ])("%s is security definer with an EMPTY pinned search_path", (name) => {
    const h = fn(name).slice(0, fn(name).indexOf("$$"));
    expect(h).toMatch(/security definer/);
    // `search_path = ''` — not `= public`, which would still let an unqualified name resolve somewhere.
    expect(h).toMatch(/set search_path = ''/);
  });

  it("takes no plaintext authorization code, and builds no SQL", () => {
    const params = [...SRC81.matchAll(/^\s*(p_[a-z_]+)\s+[a-z\[\]]+,?$/gm)].map((m) => m[1]);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      expect(p).not.toMatch(/plaintext|authorization_code|auth_code|oauth_code|token|client_secret|password|secret_value/);
    }
    for (const name of [...COMPLETER_WRAPPERS, PRODUCT_READ]) {
      expect(fn(name), `${name} must not build SQL dynamically`).not.toMatch(/\bexecute\s+format\b|\bexecute\s+'/);
    }
  });

  it("the customer read is role-gated and returns nothing protected", () => {
    const body = fn(PRODUCT_READ);
    expect(body, "a denied read must be an empty set, not an error").toMatch(
      /if not public\.has_tenant_role\(p_tenant_id, array\['owner', 'admin'\]\) then return; end if;/,
    );
    const returns = body.slice(body.indexOf("returns table ("), body.indexOf("language plpgsql"));
    expect(returns).not.toMatch(/payload|nonce|digest|attempt|claimed|scheme|key_id|connector|redirect|team|workspace/i);
    expect(body, "the read is scoped to the caller's own tenant").toMatch(/j\.tenant_id = p_tenant_id/);
  });

  it("keeps the job table a Tier-2 deny-all store", () => {
    expect(SRC81).toMatch(/alter table public\.oauth_completion_jobs enable row level security/);
    expect(SRC81).not.toMatch(/create policy[^;]*oauth_completion_jobs/);
    const revoke = SRC81.match(/revoke all on public\.oauth_completion_jobs from ([a-z_, ]+);/);
    expect(revoke, "the job table must revoke every grant").not.toBeNull();
    for (const role of ["public", "anon", "authenticated", "connector_runner", "oauth_completer"]) {
      expect(revoke![1], `the job table must revoke from ${role}`).toContain(role);
    }
  });

  it("pins provider, redirect and lifecycle in the TABLE, not only in the wrappers", () => {
    const table = SRC81.slice(SRC81.indexOf("create table public.oauth_completion_jobs"), SRC81.indexOf("comment on table"));
    expect(table).toMatch(/check \(provider = 'slack'\)/);
    expect(table).toMatch(/check \(redirect_uri = 'https:\/\/idcaddie-v3\.vercel\.app\/connectors\/oauth\/callback'\)/);
    expect(table).toMatch(/unique \(correlation_id\)/);
    expect(table, "short-lived is a constraint, not a convention").toMatch(/expires_at <= created_at \+ interval '15 minutes'/);
    // The headline invariant: a terminal row cannot hold sealed material.
    const terminal = table.slice(table.indexOf("oauth_completion_jobs_terminal_shape"));
    expect(terminal.slice(0, terminal.indexOf("),"))).toMatch(
      /protected_payload is null and payload_scheme is null and payload_key_id is null/,
    );
    // The entire terminal vocabulary, so no provider or database error text can ever be stored.
    const vocab = table.slice(table.indexOf("oauth_completion_jobs_terminal_reason_check"));
    expect(vocab.slice(0, vocab.indexOf("),"))).toMatch(
      /'expired', 'exchange_failed', 'workspace_mismatch', 'state_consume_failed', 'store_failed', 'internal'/,
    );
  });
});
