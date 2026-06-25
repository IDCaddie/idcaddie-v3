import { describe, it, expect } from "vitest";
import {
  connectorOAuthRedirectUri,
  STAGING_OAUTH_REDIRECT_URI,
  CONNECTOR_OAUTH_CALLBACK_PATH,
} from "./connector-oauth-config";

// B2c-run prep: the trusted OAuth redirect config must be the EXACT staging callback URL (not the old placeholder),
// resolved from server config only (never request-derived), and must byte-match what Slack registers + what the
// route serves.
const EXACT = "https://idcaddie-v3.vercel.app/connectors/oauth/callback";

describe("connector-oauth-config — exact staging redirect, server-config only", () => {
  it("the default is EXACTLY the staging callback URL (host + path, no trailing slash)", () => {
    expect(STAGING_OAUTH_REDIRECT_URI).toBe(EXACT);
    expect(connectorOAuthRedirectUri({})).toBe(EXACT); // no env override → staging default
    expect(connectorOAuthRedirectUri({}).endsWith("/")).toBe(false); // no trailing slash
  });
  it("the configured redirect matches the route URL EXACTLY (path = the served route path)", () => {
    // `(authenticated)` is a route group → no URL segment; the served path is /connectors/oauth/callback.
    expect(CONNECTOR_OAUTH_CALLBACK_PATH).toBe("/connectors/oauth/callback");
    expect(new URL(connectorOAuthRedirectUri({})).pathname).toBe(CONNECTOR_OAUTH_CALLBACK_PATH);
    expect(connectorOAuthRedirectUri({})).toBe(`https://idcaddie-v3.vercel.app${CONNECTOR_OAUTH_CALLBACK_PATH}`);
  });
  it("honors a CONNECTOR_OAUTH_REDIRECT_URI override that is a valid absolute-https callback URL", () => {
    expect(connectorOAuthRedirectUri({ CONNECTOR_OAUTH_REDIRECT_URI: "https://staging.idcaddie.test/connectors/oauth/callback" }))
      .toBe("https://staging.idcaddie.test/connectors/oauth/callback");
  });
  it("rejects a trailing slash, a wrong path, http, or a request-host-shaped value", () => {
    for (const bad of [
      "https://idcaddie-v3.vercel.app/connectors/oauth/callback/", // trailing slash
      "https://idcaddie-v3.vercel.app/connectors/oauth/callback?x=1", // query
      "https://idcaddie-v3.vercel.app/other", // wrong path
      "http://idcaddie-v3.vercel.app/connectors/oauth/callback", // not https
      "https:///connectors/oauth/callback", // no host
    ]) {
      expect(() => connectorOAuthRedirectUri({ CONNECTOR_OAUTH_REDIRECT_URI: bad })).toThrow();
    }
  });
  it("is resolved from config only — the function takes an env map, never a request (no Host/X-Forwarded-Host)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./connector-oauth-config.ts", import.meta.url)), "utf8").replace(/\/\/[^\n]*/g, "");
    for (const bad of ["headers(", "X-Forwarded-Host", "x-forwarded-host", "request.url", "req.url", "nextUrl", ".host"]) expect(src).not.toContain(bad);
  });
});
