// Next.js 16 Proxy convention file (the renamed Middleware — see
// node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md). One Proxy file is
// allowed per project; the logic lives in lib/supabase/proxy so it stays testable.
import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on app routes; skip Next internals and static assets (no session work needed there).
  matcher: [
    // `.well-known/` is EXCLUDED: it must be publicly reachable without a session. The Okta JWKS artifact lives there, and Okta
    // fetches it server-to-server with no cookies — a redirect to /login would present an HTML page where a JWK Set is expected
    // and silently break assertion verification. This exclusion is load-bearing, not cosmetic.
    "/((?!_next/static|_next/image|favicon.ico|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
