import { createClient } from "@/lib/supabase/server";

// The authenticated user for the current request, or null. Backed by Supabase Auth
// (getUser validates the token server-side). This is IDENTITY only — authorization over
// tenant/org data is enforced by Postgres RLS on every query, never here (docs/02).
export async function getSessionUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
