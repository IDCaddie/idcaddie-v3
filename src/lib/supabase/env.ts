// Public Supabase connection config, read from env in one place.
//
// Both values are PUBLIC: the project URL and the *publishable* anon key. They are designed
// to ship to the browser and are NOT secrets — Postgres RLS is the authorization boundary
// (see docs/02_SECURITY_AND_RLS.md), so an anon key alone grants nothing without a session.
//
// The service-role key is intentionally NOT read here or anywhere under src/. It must never
// reach a request path or the client bundle.
export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local.",
    );
  }
  return { url, anonKey };
}
