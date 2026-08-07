import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getConnectorProvider } from "./provider-registry";
import { buildSlackAuthorizeUrl } from "./providers/slack-oauth";
import { createHmacStateSigner } from "./oauth-state";

// The registry's `requiredScopes` is what `buildSlackAuthorizeUrl` asks Slack for when no caller passes scopes — and no
// caller does. A manifest endpoint that declares a scope the authorize URL never requests is not a lint failure: it is
// a token that is granted, stored, verified, and then returns 200s with the field missing. Slack's `users.list` answers
// WITHOUT `email` rather than refusing, so the failure surfaces as "discovery worked and matched nobody", days later
// and nowhere near its cause.
//
// So bind the two together at the only place both are visible.

const MANIFESTS = join(process.cwd(), "src/lib/server/connectors/manifests");

type Manifest = { endpoints?: { id?: string; required_scopes?: string[] }[] };

function manifestScopeUnion(file: string): string[] {
  const raw = JSON.parse(readFileSync(join(MANIFESTS, file), "utf8")) as Manifest;
  const all = (raw.endpoints ?? []).flatMap((e) => e.required_scopes ?? []);
  return [...new Set(all)].sort();
}

describe("provider registry scopes are the manifest's, not a hand-maintained label", () => {
  it("Slack requests EXACTLY the union of its manifest's declared endpoint scopes", () => {
    expect(existsSync(join(MANIFESTS, "slack.v1.json"))).toBe(true);
    const declared = manifestScopeUnion("slack.v1.json");
    const requested = [...(getConnectorProvider("slack")?.requiredScopes ?? [])].sort();

    // Both directions, and they fail differently on purpose. Missing => a call that 200s with the field absent.
    // Extra => asking a customer to consent to more than we will ever use, which is the thing a scope review catches.
    expect(requested).toEqual(declared);
  });

  it("the reviewed set is these three and nothing else (doc 83 §3.4)", () => {
    expect([...(getConnectorProvider("slack")?.requiredScopes ?? [])].sort())
      .toEqual(["usergroups:read", "users:read", "users:read.email"]);
  });

  it("no Slack scope grants write, posting, or channel access", () => {
    for (const s of getConnectorProvider("slack")?.requiredScopes ?? []) {
      expect(s).toMatch(/:read(\.[a-z]+)?$/);
      expect(s).not.toMatch(/^(chat|channels|groups|im|mpim|files|admin)[.:]/);
    }
  });

  // The end of the chain: what actually lands in the URL Slack sees, with NO caller-supplied scopes — which is how
  // every real caller invokes it. `slack-oauth.test.ts` already asserts the scope parameter, but against
  // `getConnectorProvider("slack").requiredScopes` — the same value the builder reads. That assertion is a tautology
  // and passed happily with the scope missing. This one compares against the literal set instead.
  it("the built authorize URL carries all three scopes when no caller supplies any", () => {
    const REDIRECT = "https://idcaddie-v3.vercel.app/connectors/oauth/callback";
    const res = buildSlackAuthorizeUrl({
      ctx: {
        tenantId: "aaaa1111-1111-1111-1111-111111111111",
        provider: "slack",
        connectorId: "bbbb2222-2222-2222-2222-222222222222",
        subject: "cccc3333-3333-3333-3333-333333333333",
        redirectIntent: "connect",
        // `redirectUri` and `correlationId` are deliberately absent from `ctx` — the builder injects them from the
        // top-level fields, so the redirect bound into the state IS the authorize redirect_uri, by construction.
      },
      clientId: "11111.22222",
      redirectUri: REDIRECT,
      correlationId: "corr-scope-test",
      signer: createHmacStateSigner("test-only-state-secret-not-a-real-secret", "k1"),
      now: 1_750_000_000_000,
      nonce: "nonce-scope-test",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const scope = new URL(res.url).searchParams.get("scope") ?? "";
    const granted = scope.split(/[ ,]/).filter(Boolean).sort();
    expect(granted).toEqual(["usergroups:read", "users:read", "users:read.email"]);
    // The consent screen is the one place a customer sees this. Nothing beyond the three may ride along.
    expect(res.url).not.toMatch(/chat:write|channels:|admin\./);
  });
});
