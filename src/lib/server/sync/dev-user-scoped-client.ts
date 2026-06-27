// Server-only, LOCAL-DEV-ONLY user-scoped Supabase client for the manual Slack sync run (PR 6). The standard
// `@/lib/supabase/server` client is cookie-bound (needs a Next.js request) — a standalone manual run has no request, so
// this builds a user-scoped client from a dev tenant-member's JWT instead.
//
// It uses ONLY the PUBLIC anon key + the dev user's JWT in the Authorization header, so every query runs AS THAT USER
// and is governed by RLS — exactly like the cookie client. It is NEVER a service-role/admin client (there is no
// service-role key here). The JWT is read from a server-only env var and is NEVER logged/printed/returned. Structurally
// disabled outside local dev (the same allowlist guard as the run).
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseEnv } from "../../supabase/env"; // relative (not "@/…") so the manual-run entrypoint resolves it outside the bundler
import type { Database } from "@/lib/database.types";
import { isDevSlackSyncRunEnabled } from "./run-slack-sync-dev";

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/dev-user-scoped-client is server-only and must not be imported in client code");
}

const DEV_USER_JWT = "ID_CADDIE_DEV_USER_JWT"; // a dev tenant-member's access token — server-only; NOT a service key.

// Build a USER-SCOPED (RLS-enforced) Supabase client from the dev user's JWT. Fails closed outside local dev + opt-in;
// throws a GENERIC error (never echoes the JWT) when the token is absent.
export function createDevUserScopedClient(env: Record<string, string | undefined> = process.env): SupabaseClient<Database> {
  if (!isDevSlackSyncRunEnabled(env))
    throw new Error("dev user-scoped client is disabled (local dev + explicit opt-in only)");
  const jwt = env[DEV_USER_JWT];
  if (typeof jwt !== "string" || jwt.length === 0)
    throw new Error("ID_CADDIE_DEV_USER_JWT is not set (a dev tenant-member access token is required)"); // never echoes the value
  const { url, anonKey } = supabaseEnv(); // PUBLIC anon key — never the service-role key
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, // the JWT scopes every request to the user → RLS applies
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
