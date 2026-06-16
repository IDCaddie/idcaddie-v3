import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// /logout — clears the Supabase session, then redirects to /login.
// signOut() removes the auth cookies via the server client's cookie writer; Proxy also
// treats the (now invalid) session as logged out on the next request as a backstop.
// POST is the real path (used by the sign-out form). GET is allowed for convenience.
async function handle(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // 303 so a POST is followed with a GET to /login.
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}

export const POST = handle;
export const GET = handle;
