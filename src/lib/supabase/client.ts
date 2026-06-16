"use client";

// Browser Supabase client. Uses ONLY the public anon key (via supabaseEnv) and is safe in
// the client bundle. Never import the server client or any service-role key here.
//
// Not yet consumed (this PR has no interactive client components) but is the foundation for
// future client-side reads, which are still governed by RLS under the user's session.
import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

export function createClient() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient(url, anonKey);
}
