import { describe, it, expect, vi } from "vitest";

// The dev user-scoped client must (a) fail closed outside local dev + opt-in, (b) use the PUBLIC anon key + the dev
// JWT in the Authorization header (user-scoped → RLS; NEVER service-role), (c) never echo the JWT. Mock the supabase
// factory + env so no real client/network is created.
const JWT = "dev-jwt-MUSTNOTLEAK-value";
const created: { url: string; key: string; opts: { global?: { headers?: Record<string, string> } } }[] = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, opts: { global?: { headers?: Record<string, string> } }) => { created.push({ url, key, opts }); return { __mock: true }; },
}));
vi.mock("@/lib/supabase/env", () => ({ supabaseEnv: () => ({ url: "http://localhost:54321", anonKey: "ANON_PUBLIC_KEY" }) }));

import { createDevUserScopedClient } from "./dev-user-scoped-client";

const DEV = { NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1", ID_CADDIE_DEV_USER_JWT: JWT } as Record<string, string | undefined>;

describe("createDevUserScopedClient", () => {
  it("builds a user-scoped client with the PUBLIC anon key + the JWT in the Authorization header (not service-role)", () => {
    created.length = 0;
    createDevUserScopedClient(DEV);
    expect(created).toHaveLength(1);
    expect(created[0].key).toBe("ANON_PUBLIC_KEY"); // anon, never a service-role key
    expect(created[0].opts.global?.headers?.Authorization).toBe(`Bearer ${JWT}`);
  });
  it("fails closed outside local dev / without opt-in", () => {
    for (const env of [{ NODE_ENV: "production", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1", ID_CADDIE_DEV_USER_JWT: JWT },
      { NODE_ENV: "development", ID_CADDIE_DEV_USER_JWT: JWT }, { NODE_ENV: "development", VERCEL_ENV: "preview", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1", ID_CADDIE_DEV_USER_JWT: JWT }])
      expect(() => createDevUserScopedClient(env)).toThrow();
  });
  it("missing JWT throws a generic error that never echoes the (absent) value", () => {
    try { createDevUserScopedClient({ NODE_ENV: "development", ID_CADDIE_DEV_SLACK_SYNC_ENABLED: "1" }); expect.unreachable(); }
    catch (e) { expect((e as Error).message).not.toContain(JWT); expect((e as Error).message).toMatch(/ID_CADDIE_DEV_USER_JWT/); }
  });
});
