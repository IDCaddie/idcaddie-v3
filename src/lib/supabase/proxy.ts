// Session-refresh + route-protection helper used by Proxy (src/proxy.ts).
//
// In Next.js 16, Middleware was renamed to Proxy (see
// node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md). Same functionality.
//
// This helper ONLY:
//   - refreshes the Supabase auth session cookies on the response, and
//   - redirects unauthenticated requests for protected routes to /login.
// It deliberately does NOT read app data and does NOT make any tenant/org authorization
// decision — that is RLS's job, enforced when the app actually queries data (docs/02, docs/01).
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "./env";

// Path prefixes reachable without a session. Everything else requires a signed-in user.
const PUBLIC_PREFIXES = ["/login", "/logout", "/auth"];

function isPublic(pathname: string) {
  return PUBLIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url, anonKey } = supabaseEnv();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // getUser() validates the token against the Auth server — not just a cookie read — so an
  // expired/forged session is treated as logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(request.nextUrl.pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
