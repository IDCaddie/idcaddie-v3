// Server-only real fetch() adapter for the Slack client's injected SlackHttpClient seam (#188). The client took an
// injected http fn so it could be unit-tested with no network; the manual LIVE run (PR 6) needs a real one. This is the
// ONLY place a real Slack network call originates, and it adds nothing of its own — no token (the client sets the
// Authorization header), no logging, no body mutation.

import type { SlackHttpClient } from "./slack/slack-client";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("server/sync/slack-fetch-http-client is server-only and must not be imported in client code");
}

export const slackFetchHttpClient: SlackHttpClient = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    headers: { get: (name) => res.headers.get(name) },
    json: () => res.json(),
  };
};
