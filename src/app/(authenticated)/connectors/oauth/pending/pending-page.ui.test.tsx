// @vitest-environment jsdom
//
// Phase 8K — the pending page's SERVER half.
//
// `pending-status.ui.test.tsx` proves the component renders what it is given. This file proves the page gives it the
// right thing, which is a separate claim and was an unproven one: replacing the page's `await getSlackConnectionStatus(...)`
// with a hardcoded `{ state: "completed", terminal: true }` made every customer see "Connection completed / Slack is
// connected" on first paint, before the worker had done anything — exactly the lie doc 83 exists to prevent — and the
// entire suite stayed green. Same for the server action behind the poller.
// (Found in adversarial review of PR #398.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ConnectionStatus } from "@/lib/data/oauth-completion-status";

const getSlackConnectionStatus = vi.fn<(c: string | null | undefined) => Promise<ConnectionStatus>>();
vi.mock("@/lib/data/oauth-completion-status", () => ({
  getSlackConnectionStatus: (c: string | null | undefined) => getSlackConnectionStatus(c),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

import OAuthPendingPage from "./page";
import { pollSlackConnectionStatusAction } from "./actions";

const completing: ConnectionStatus = { state: "completing", terminal: false };

beforeEach(() => getSlackConnectionStatus.mockReset());
afterEach(cleanup);

const renderPage = async (sp: Record<string, string | string[] | undefined>) =>
  render(await OAuthPendingPage({ searchParams: Promise.resolve(sp) }));

describe("the pending page's first paint", () => {
  it("renders the DURABLE state the wrapper reported, not an optimistic one", async () => {
    for (const [status, heading] of [
      [completing, "Completing your Slack connection"],
      [{ state: "completed", terminal: true } as ConnectionStatus, "Connection completed"],
      [{ state: "failed", terminal: true } as ConnectionStatus, "Connection failed"],
      [{ state: "expired", terminal: true } as ConnectionStatus, "Connection expired"],
    ] as const) {
      cleanup();
      getSlackConnectionStatus.mockResolvedValue(status);
      await renderPage({ c: "corr-live-run-1" });
      expect(screen.getByText(heading), status.state).toBeTruthy();
    }
  });

  it("reads the correlation id from the query and passes it through unchanged", async () => {
    getSlackConnectionStatus.mockResolvedValue(completing);
    await renderPage({ c: "corr-live-run-1" });
    expect(getSlackConnectionStatus).toHaveBeenCalledWith("corr-live-run-1");
  });

  it("never claims a connection on its own — a missing or repeated ?c= is not success", async () => {
    // The DAL is the only authority; the page must not invent a status when the query is unusable. It hands the empty
    // string straight through and lets the DAL refuse, rather than short-circuiting to anything.
    for (const sp of [{}, { c: undefined }, { c: ["a", "b"] }]) {
      cleanup();
      getSlackConnectionStatus.mockResolvedValue({ state: "failed", terminal: true });
      await renderPage(sp);
      expect(getSlackConnectionStatus).toHaveBeenCalledWith("");
      expect(document.body.textContent).not.toContain("Connection completed");
    }
  });

  it("is force-dynamic, so a refresh reads the job rather than a cached page", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("node:fs") as typeof import("node:fs"))
      .readFileSync("src/app/(authenticated)/connectors/oauth/pending/page.tsx", "utf8");
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
  });
});

describe("the poll action", () => {
  it("is the same bounded read, with nothing added", async () => {
    getSlackConnectionStatus.mockResolvedValue(completing);
    expect(await pollSlackConnectionStatusAction("corr-live-run-1")).toEqual(completing);
    expect(getSlackConnectionStatus).toHaveBeenCalledWith("corr-live-run-1");
  });

  it("cannot report completed unless the read did", async () => {
    for (const status of [completing, { state: "failed", terminal: true } as ConnectionStatus]) {
      getSlackConnectionStatus.mockResolvedValue(status);
      expect(await pollSlackConnectionStatusAction("corr-live-run-1")).toEqual(status);
    }
  });
});
