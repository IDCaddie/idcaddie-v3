// User-scoped server Supabase client. Bound to the request's auth cookies, so every query
// runs *as the signed-in user* and is governed by Postgres RLS (docs/02_SECURITY_AND_RLS.md).
// Uses ONLY the public anon key — NEVER the service-role key. This is the single entry point
// for server-side data access; do not construct Supabase clients ad hoc elsewhere.
//
// Importing next/headers makes this module server-only (it throws if pulled into a client
// bundle), which is the boundary we want.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";
import type { Database } from "@/lib/database.types";

export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component, where the cookie store is read-only. Safe to
          // ignore: Proxy (src/proxy.ts) refreshes the session cookies on each request.
        }
      },
    },
  });
}
