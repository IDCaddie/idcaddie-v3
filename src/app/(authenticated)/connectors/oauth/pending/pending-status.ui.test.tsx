// @vitest-environment jsdom
//
// Phase 8K — the pending screen. What a customer is told while a connection they cannot see is being completed.
//
// The screen has no opinion. Every word it shows comes from a state the server returned, and there is no path through
// this component that reaches "Connection completed" without the server having said `completed`. That is the property
// under test, along with the two that keep it honest: polling stops on a terminal state, and a refresh shows the
// durable truth rather than restarting a hopeful spinner.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import type { ConnectionStatus } from "@/lib/data/oauth-completion-status";
import { MAX_POLLS, POLL_INTERVAL_MS, PendingStatus } from "./pending-status";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));

const CORR = "corr-live-run-1";
const completing: ConnectionStatus = { state: "completing", terminal: false };
const completed: ConnectionStatus = { state: "completed", terminal: true };
const failed: ConnectionStatus = { state: "failed", terminal: true };
const expired: ConnectionStatus = { state: "expired", terminal: true };

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => { vi.useRealTimers(); cleanup(); });

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("what the customer is told", () => {
  it("says the connection is being COMPLETED — never that it is connected", () => {
    render(<PendingStatus correlationId={CORR} initial={completing} poll={async () => completing} />);
    expect(screen.getByText("Completing your Slack connection")).toBeTruthy();
    const body = document.body.textContent ?? "";
    for (const lie of ["Connected", "Sync complete", "Slack verified", "Token stored", "Success"]) {
      expect(body, lie).not.toContain(lie);
    }
  });

  it("shows 'Connection completed' ONLY once the server says completed", async () => {
    const poll = vi.fn<() => Promise<ConnectionStatus>>().mockResolvedValueOnce(completing).mockResolvedValue(completed);
    render(<PendingStatus correlationId={CORR} initial={completing} poll={poll} />);
    expect(screen.queryByText("Connection completed")).toBeNull();
    await advance(POLL_INTERVAL_MS);
    expect(screen.queryByText("Connection completed")).toBeNull(); // still `completing`
    await advance(POLL_INTERVAL_MS);
    await waitFor(() => expect(screen.getByText("Connection completed")).toBeTruthy());
  });

  it("offers a retry on the two states a customer can act on, and not on the others", () => {
    for (const [status, retry] of [[completing, false], [completed, false], [failed, true], [expired, true]] as const) {
      cleanup();
      render(<PendingStatus correlationId={CORR} initial={status} poll={async () => status} />);
      const link = screen.queryByRole("link", { name: "Retry connection" });
      expect(Boolean(link), status.state).toBe(retry);
      if (link) expect(link.getAttribute("href")).toBe("/connectors/slack");
    }
  });

  it("uses customer language — no engineering or security vocabulary anywhere on the screen", () => {
    for (const status of [completing, completed, failed, expired]) {
      cleanup();
      render(<PendingStatus correlationId={CORR} initial={status} poll={async () => status} />);
      const body = document.body.textContent ?? "";
      for (const word of [
        "worker", "job", "claim", "enqueue", "envelope", "payload", "digest", "correlation", "OIDC", "JWT",
        "tenant", "connector_", "RPC", "database", "KMS", "token", "OAuth code", "exchange_failed", "state_consume",
      ]) {
        expect(body.toLowerCase(), `${status.state}: ${word}`).not.toContain(word.toLowerCase());
      }
    }
  });

  it("displays no identifier of any kind — not the correlation id, not a uuid", () => {
    for (const status of [completing, completed, failed, expired]) {
      cleanup();
      render(<PendingStatus correlationId={CORR} initial={status} poll={async () => status} />);
      const body = document.body.textContent ?? "";
      expect(body).not.toContain(CORR);
      expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });
});

describe("polling is bounded and stops on terminal", () => {
  it("does not poll at all when the FIRST render is already terminal", async () => {
    const poll = vi.fn(async () => completed);
    render(<PendingStatus correlationId={CORR} initial={completed} poll={poll} />);
    await advance(POLL_INTERVAL_MS * 5);
    expect(poll).not.toHaveBeenCalled();
  });

  it("stops the moment a terminal state arrives", async () => {
    for (const terminal of [completed, failed, expired]) {
      cleanup();
      const poll = vi.fn<() => Promise<ConnectionStatus>>().mockResolvedValueOnce(completing).mockResolvedValue(terminal);
      render(<PendingStatus correlationId={CORR} initial={completing} poll={poll} />);
      await advance(POLL_INTERVAL_MS * 2);
      const callsAtTerminal = poll.mock.calls.length;
      await advance(POLL_INTERVAL_MS * 10);
      expect(poll.mock.calls.length, terminal.state).toBe(callsAtTerminal);
    }
  });

  it("gives up after a bounded number of attempts and says so truthfully", async () => {
    const poll = vi.fn(async () => completing);
    render(<PendingStatus correlationId={CORR} initial={completing} poll={poll} />);
    await advance(POLL_INTERVAL_MS * (MAX_POLLS + 10));
    expect(poll.mock.calls.length).toBe(MAX_POLLS);
    // Still "completing" — the honest answer. It does not guess an ending it was never told.
    expect(screen.getByText("Completing your Slack connection")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Refresh this page to check again/)).toBeTruthy());
    expect(document.body.textContent).not.toContain("Connection failed");
  });

  it("a failing poll does not become a failed connection", async () => {
    const poll = vi.fn<() => Promise<ConnectionStatus>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(completed);
    render(<PendingStatus correlationId={CORR} initial={completing} poll={poll} />);
    await advance(POLL_INTERVAL_MS * 2);
    expect(screen.getByText("Completing your Slack connection")).toBeTruthy();
    await advance(POLL_INTERVAL_MS * 2);
    await waitFor(() => expect(screen.getByText("Connection completed")).toBeTruthy());
  });

  it("stops polling when unmounted", async () => {
    const poll = vi.fn(async () => completing);
    const { unmount } = render(<PendingStatus correlationId={CORR} initial={completing} poll={poll} />);
    await advance(POLL_INTERVAL_MS * 2);
    const before = poll.mock.calls.length;
    unmount();
    await advance(POLL_INTERVAL_MS * 5);
    expect(poll.mock.calls.length).toBe(before);
  });

  // The case `clearTimeout` alone cannot cover: a poll already IN FLIGHT when the component goes away. Its resolution
  // must not schedule the next one. Mutation testing is what surfaced this — the two cancellation checks the component
  // used to carry each masked the other's removal, so neither was actually under test.
  it("a poll in flight at unmount does not schedule another", async () => {
    let release: (s: ConnectionStatus) => void = () => {};
    const poll = vi.fn(() => new Promise<ConnectionStatus>((resolve) => { release = resolve; }));
    const { unmount } = render(<PendingStatus correlationId={CORR} initial={completing} poll={poll} />);
    await advance(POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { release(completing); });
    await advance(POLL_INTERVAL_MS * 5);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("a refresh shows the durable truth", () => {
  it("renders whatever the server already knows, without a hopeful spinner in front of it", () => {
    // A remount is what a refresh is: the first paint is the server's answer, not "completing" by default.
    for (const [status, heading] of [
      [completed, "Connection completed"],
      [failed, "Connection failed"],
      [expired, "Connection expired"],
      [completing, "Completing your Slack connection"],
    ] as const) {
      cleanup();
      render(<PendingStatus correlationId={CORR} initial={status} poll={async () => status} />);
      expect(screen.getByText(heading), status.state).toBeTruthy();
    }
  });
});
