import { createClient } from "@/lib/supabase/server";
import type { DataResult } from "@/lib/data/apps";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// P1 of docs/70 (controlled promotion): READ-ONLY, COUNT-ONLY readiness classifier for CONFIRMED `app_user_account`
// discovery facts. It answers "how many confirmed app_user_account facts would resolve / conflict / are already
// represented" — WITHOUT promoting anything.
//
// SAFETY (docs/70 §5):
//   * READ-ONLY: only `.select(...)`. NO insert/update/upsert/delete/rpc — no canonical write, no promotion, no audit.
//   * RLS is the tenant authority: imports the user-scoped server client (anon key) — NEVER a service-role/admin client
//     and NEVER the connector_runner role. Takes NO tenant_id from the caller; RLS (`members read` on discovery_facts
//     0025 / apps + app_users 0001) decides which tenant's rows are visible. No cross-tenant query.
//   * COUNT-ONLY OUT: returns ONLY integer bucket counts + a fixed error union. It NEVER returns or logs a row body —
//     no fact_json, natural_key, signal_id, source_record_id, provenance_json, email, external id, name, payload, or
//     secret. The identity anchors below are read into memory ONLY to compute a bucket, then discarded.
//   * DETERMINISTIC ONLY (docs/70 §4): exact natural-key existence checks; NO fuzzy matching, NO email-across-tenant.
//   * FAIL CLOSED: any auth/DB error → { ok: false } (no partial result); the log line carries NO values.
//
// SCOPE: `fact_type = 'app_user_account'`, `review_status = 'confirmed'` ONLY (pending/rejected/auto/needs_review are
// excluded). Broader fact types are NOT classified here (docs/70 P5, separate approval).
//
// SCHEMA NOTE (reported vs docs/70 §2.1): the fact's identity anchors live in `fact_json`, not columns —
// `app_user_external_id` (fallback `source_user_id`) → `app_users.external_user_id`; `email`; and the app instance is
// resolved via `app_instance_key` → `apps.external_instance_id` (UNIQUE(tenant, external_instance_id), 0036). `app_id`
// is NOT on the fact. Email-only (no external id) canNOT form the `app_users` natural key `(tenant, app_id,
// external_user_id)` — the runner already skips it — so it classifies as `missing_required`, matching the runner.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PromotionReadinessCounts = {
  ready: number; // deterministic target resolved, not yet represented, no collision → promotable
  alreadyRepresented: number; // (app_id, external_user_id) already exists in app_users → idempotent no-op
  conflict: number; // duplicate email: (app_id, lower(email)) already held by a DIFFERENT external_user_id
  missingRequired: number; // no external anchor (app_user_external_id AND source_user_id both absent)
  unsupported: number; // no app_instance_key, or it resolves to no apps row (app creation is out of scope here)
  total: number; // == number of confirmed app_user_account facts (cross-check: sum of the five buckets)
};

// Minimal in-memory shapes — ONLY the anchor fields needed to classify (never the full body).
type FactAnchors = { ext: string | null; suid: string | null; email: string | null; ikey: string | null };
type AppRow = { id: string; external_instance_id: string | null };
type AppUserRow = { app_id: string; external_user_id: string | null; email: string | null };

const norm = (s: string | null): string | null => {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
};
const KEYSEP = "\u0000"; // NUL — never a legal id/email/instance-key char, so composite keys cannot collide.

// PURE deterministic classifier (docs/70 §4 precedence, first hit wins). No I/O; trivially testable per branch.
export function classifyAppUserAccountReadiness(
  facts: FactAnchors[],
  apps: AppRow[],
  appUsers: AppUserRow[],
): PromotionReadinessCounts {
  const appIdByInstanceKey = new Map<string, string>();
  for (const a of apps) {
    const k = norm(a.external_instance_id);
    if (k) appIdByInstanceKey.set(k, a.id); // UNIQUE(tenant, external_instance_id) ⇒ at most one per key.
  }
  const existingExtId = new Set<string>(); // `${app_id}${SEP}${external_user_id}`
  const existingEmail = new Set<string>(); // `${app_id}${SEP}${lower(email)}`
  for (const u of appUsers) {
    const ext = norm(u.external_user_id);
    if (ext) existingExtId.add(u.app_id + KEYSEP + ext);
    const em = norm(u.email);
    if (em) existingEmail.add(u.app_id + KEYSEP + em.toLowerCase());
  }

  const c: PromotionReadinessCounts = { ready: 0, alreadyRepresented: 0, conflict: 0, missingRequired: 0, unsupported: 0, total: facts.length };
  for (const fct of facts) {
    const extId = norm(fct.ext) ?? norm(fct.suid);
    if (!extId) { c.missingRequired++; continue; } // 1. no external anchor
    const ikey = norm(fct.ikey);
    if (!ikey) { c.unsupported++; continue; } // 2. no app instance key
    const appId = appIdByInstanceKey.get(ikey);
    if (!appId) { c.unsupported++; continue; } // 3. app instance not resolvable (app creation out of scope)
    if (existingExtId.has(appId + KEYSEP + extId)) { c.alreadyRepresented++; continue; } // 4. exact natural key exists → no-op
    const em = norm(fct.email);
    if (em && existingEmail.has(appId + KEYSEP + em.toLowerCase())) { c.conflict++; continue; } // 5. duplicate email (different account)
    c.ready++; // 6. deterministic, unrepresented, no collision
  }
  return c;
}

// ── Read-only fetch + classify (RLS-scoped, fail-closed) ───────────────────────────────────────────────────────────

const PAGE = 1000; // ponytail: PostgREST default cap. Page until a short read. Move classification into SQL only if a
                   // single tenant ever dwarfs this (would need an RPC = migration = stop-and-ask per docs/70 §11).

// Page through a range-limited SELECT, accumulating rows. Returns null on the first DB error (fail-closed).
async function selectAll<T>(
  make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[] | null> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) return null;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// Count-only promotion-readiness summary for CONFIRMED app_user_account facts in the current tenant (RLS-scoped).
// Reads only the anchor subfields (never a full body); classifies in memory; returns COUNTS ONLY. Fails closed.
export async function getAppUserAccountPromotionReadiness(): Promise<DataResult<PromotionReadinessCounts>> {
  const supabase = await createClient();

  // Confirmed app_user_account facts — ONLY the anchor subfields (no fact_json blob, no natural_key/signal_id/
  // provenance/source_record_id). Pending/rejected/auto/needs_review are excluded by the confirmed filter.
  const facts = await selectAll<FactAnchors>((from, to) =>
    supabase
      .from("discovery_facts")
      .select("ext:fact_json->>app_user_external_id, suid:fact_json->>source_user_id, email:fact_json->>email, ikey:fact_json->>app_instance_key")
      .eq("review_status", "confirmed")
      .eq("fact_type", "app_user_account")
      .range(from, to),
  );
  // apps (tenant-scoped by RLS) → instance-key → app_id resolution. Only the join keys.
  const apps = await selectAll<AppRow>((from, to) =>
    supabase.from("apps").select("id, external_instance_id").range(from, to),
  );
  // Existing app_users (tenant-scoped by RLS) → natural-key + email existence. Only the keys needed to detect no-op /
  // duplicate; values are compared in memory and never returned or logged.
  const appUsers = await selectAll<AppUserRow>((from, to) =>
    supabase.from("app_users").select("app_id, external_user_id, email").range(from, to),
  );

  if (facts === null || apps === null || appUsers === null) {
    console.error("[data/promotion-readiness] readiness query failed"); // fixed string — NO values
    return { ok: false, error: "query_failed" };
  }

  return { ok: true, data: classifyAppUserAccountReadiness(facts, apps, appUsers) };
}
