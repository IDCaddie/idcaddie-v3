// Server-only CONCRETE Supabase resolver store for the Slack P0 manual run (PR 6). Implements the PR #190
// `SlackResolverStore` seam over an INJECTED user-scoped Supabase client (the dev-user-JWT client; NEVER service-role).
//
// Idempotency is DB-enforced by the migration-0036 tenant-scoped natural keys (proven at the real-RLS SQL layer by
// org_rls_test.sql Test 58): apps(tenant_id, external_instance_id), app_users(tenant_id, app_id, external_user_id) use
// PostgREST `upsert(onConflict=…)`; people uses a get-or-create against the functional unique index
// (tenant_id, lower(primary_email)) — which PostgREST cannot name as an onConflict target — with the index as the race
// safety net; matches mirror identity-match-write.ts (ON CONFLICT (tenant_id, app_user_id) DO NOTHING — never repoints).
//
// RLS (not service-role) is the authoritative tenant boundary; this store is the user-scoped caller. It never writes a
// token / auth header / raw Slack object (the resolver passes only sanitized fields), and it surfaces only a safe
// `store_write_failed` on error — never row data or a raw DB error.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { SlackResolverStore } from "../connector-vault/slack-resolver-write";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/supabase-slack-resolver-store is server-only and must not be imported in client code");
}

export type StoreWriteTable = "apps" | "app_users" | "people" | "app_user_identity_matches";
export type StoreWriteOp = "upsert_app" | "upsert_app_user" | "upsert_person" | "upsert_match";
// SAFE structured failure — ONLY the table, the operation, and the SQLSTATE/PostgREST `code`. The DB error message /
// details / hint are NEVER captured: a unique/RLS violation message embeds row VALUES (e.g. an email), the code does not.
export type StoreWriteFailure = { table: StoreWriteTable; op: StoreWriteOp; code: string | null };

export class StoreWriteError extends Error {
  readonly failure: StoreWriteFailure;
  constructor(failure: StoreWriteFailure) {
    super("store_write_failed"); // SAFE static message — never row data / a raw DB message / a token
    this.name = "StoreWriteError";
    this.failure = failure;
  }
}
// Capture ONLY a short SQLSTATE / PostgREST code (e.g. "42501", "23505", "PGRST204") — never message/details/hint.
function pgCode(error: unknown): string | null {
  const c = (error as { code?: unknown } | null | undefined)?.code;
  return typeof c === "string" && c.length > 0 && c.length <= 12 ? c : null;
}
const PG_UNIQUE_VIOLATION = "23505";

// Escape SQL LIKE/ILIKE metacharacters so a value is matched LITERALLY (case-insensitively), not as a pattern.
// ponytail: 3-char-class regex, not a LIKE-builder lib.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function createSupabaseSlackResolverStore(supabase: SupabaseClient<Database>): SlackResolverStore {
  return {
    async upsertApp(input) {
      const { data, error } = await supabase
        .from("apps")
        .upsert(
          {
            tenant_id: input.tenantId,
            external_instance_id: input.externalInstanceId,
            name: input.name,
            ...(input.vendorName ? { vendor_name: input.vendorName } : {}),
            ...(input.category ? { category: input.category } : {}),
            ...(input.instanceUrl ? { instance_url: input.instanceUrl } : {}),
          },
          { onConflict: "tenant_id,external_instance_id" },
        )
        .select("id")
        .single();
      if (error || !data) throw new StoreWriteError({ table: "apps", op: "upsert_app", code: pgCode(error) });
      return { appId: data.id };
    },

    async upsertAppUser(input) {
      const { data, error } = await supabase
        .from("app_users")
        .upsert(
          {
            tenant_id: input.tenantId,
            app_id: input.appId,
            external_user_id: input.externalUserId,
            ...(input.email ? { email: input.email } : {}),
            ...(input.displayName ? { display_name: input.displayName } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...(input.lastActiveAt ? { last_active_at: input.lastActiveAt } : {}),
            ...(input.rawProvenance ? { raw_payload: input.rawProvenance } : {}), // SANITIZED scalars only (never the raw Slack object)
          },
          { onConflict: "tenant_id,app_id,external_user_id" },
        )
        .select("id")
        .single();
      if (error || !data) throw new StoreWriteError({ table: "app_users", op: "upsert_app_user", code: pgCode(error) });
      return { appUserId: data.id };
    },

    async upsertPerson(input) {
      // get-or-create against the functional unique index (tenant_id, lower(primary_email)), which dedups across case.
      // ilike treats `_`/`%` as wildcards (both legal in email local parts, e.g. `john_doe@`), so ESCAPE them — the
      // lookup must be a LITERAL case-insensitive exact match, not a pattern, or it could return the WRONG person.
      const emailLike = escapeLike(input.primaryEmail);
      const findExisting = () =>
        supabase.from("people").select("id").eq("tenant_id", input.tenantId).ilike("primary_email", emailLike).limit(1).maybeSingle();
      const existing = await findExisting();
      if (existing.error) throw new StoreWriteError({ table: "people", op: "upsert_person", code: pgCode(existing.error) });
      if (existing.data) return { personId: existing.data.id };
      const ins = await supabase
        .from("people")
        .insert({ tenant_id: input.tenantId, primary_email: input.primaryEmail, ...(input.fullName ? { full_name: input.fullName } : {}) })
        .select("id")
        .single();
      if (!ins.error && ins.data) return { personId: ins.data.id };
      // a concurrent insert raced us → the unique index rejected it; re-select the now-present row.
      if (ins.error?.code === PG_UNIQUE_VIOLATION) {
        const reselect = await findExisting();
        if (!reselect.error && reselect.data) return { personId: reselect.data.id };
      }
      throw new StoreWriteError({ table: "people", op: "upsert_person", code: pgCode(ins.error) });
    },

    async getExistingMatchPersonId(input) {
      const { data, error } = await supabase
        .from("app_user_identity_matches")
        .select("person_id")
        .eq("tenant_id", input.tenantId)
        .eq("app_user_id", input.appUserId)
        .maybeSingle();
      if (error) throw new StoreWriteError({ table: "app_user_identity_matches", op: "upsert_match", code: pgCode(error) });
      return data?.person_id ?? null;
    },

    async insertMatch(input) {
      // ON CONFLICT (tenant_id, app_user_id) DO NOTHING — never repoints an existing match (the 0028 invariant). The
      // resolver only calls this after getExistingMatchPersonId clears a different-person conflict.
      const { data, error } = await supabase
        .from("app_user_identity_matches")
        .upsert(
          { tenant_id: input.tenantId, app_user_id: input.appUserId, person_id: input.personId, match_method: input.matchMethod },
          { onConflict: "tenant_id,app_user_id", ignoreDuplicates: true },
        )
        .select("id");
      if (error) throw new StoreWriteError({ table: "app_user_identity_matches", op: "upsert_match", code: pgCode(error) });
      return { created: (data?.length ?? 0) > 0 }; // DO NOTHING returns no row on conflict → created=false
    },
  };
}
