import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// updateSession (the Proxy/middleware helper) redirects unauthenticated requests for protected routes to /login.
// REQUEST-PATH DISCIPLINE (docs/44 §2): the redirect must NOT carry the original query into /login — a protected
// route's query can hold sensitive material (e.g. the OAuth callback's ?code=&state=), which would otherwise land in
// access logs / browser history / referer / analytics. This proves the query is dropped. Synthetic only.

vi.mock("@supabase/ssr", () => ({
  // a null-user client (unauthenticated) — getUser validates server-side; here it returns no user.
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("./env", () => ({ supabaseEnv: () => ({ url: "https://stub.invalid", anonKey: "anon-key" }) }));

import { updateSession } from "./proxy";

const CODE = "CODE-MUSTNOTLEAK-authcode";
const STATE = "STATE-MUSTNOTLEAK-statevalue";

describe("proxy updateSession — unauthenticated redirect drops the original query (no OAuth code/state leak)", () => {
  it("an unauthenticated OAuth callback redirects to a CLEAN /login — no ?code/state carried over", async () => {
    const req = new NextRequest(`https://app.example.com/connectors/oauth/callback?code=${CODE}&state=${STATE}`);
    const res = await updateSession(req);
    expect(res.status).toBe(307); // NextResponse.redirect
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("/login");
    expect(new URL(loc).search).toBe(""); // the query is fully dropped
    for (const leak of [CODE, STATE, "MUSTNOTLEAK", "code", "state"]) expect(loc).not.toContain(leak);
  });
  it("any protected route's query is dropped on the /login redirect (general, not just the callback)", async () => {
    const req = new NextRequest("https://app.example.com/some/protected/page?secret=MUSTNOTLEAK-token&x=1");
    const res = await updateSession(req);
    const loc = res.headers.get("location") ?? "";
    expect(new URL(loc).pathname).toBe("/login");
    expect(loc).not.toContain("MUSTNOTLEAK");
    expect(new URL(loc).search).toBe("");
  });
  it("a public path (/login) is NOT redirected (passes through)", async () => {
    const req = new NextRequest("https://app.example.com/login?error=x");
    const res = await updateSession(req);
    expect(res.status).not.toBe(307); // NextResponse.next() — not a redirect
  });
});
