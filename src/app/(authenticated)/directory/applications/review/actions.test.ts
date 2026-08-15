import { describe, it, expect, vi, beforeEach } from "vitest";

// redirect() throws in Next; capture the target URL. revalidatePath is recorded so the refresh contract can be asserted.
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

// Mock ONLY the command wrapper. `isDecision` — the gate that decides what may be posted — stays real.
const decide = vi.fn();
vi.mock("@/lib/data/application-match-review", () => ({ decideApplicationMatch: (m: string, d: string) => decide(m, d) }));

import { decideApplicationMatchAction } from "./actions";

const ROUTE = "/directory/applications/review";
const MATCH = "m1111111-1111-1111-1111-111111111111";

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>): Promise<string | null> => {
  try { await p; return null; } catch (e) { return (e as Error).message; }
};

beforeEach(() => { decide.mockReset(); revalidatePath.mockReset(); });

describe("B5 / B6 — one decision, one candidate, through the governed command", () => {
  it("accept posts the match id and 'accepted', then reports what the database said", async () => {
    decide.mockResolvedValue({ ok: true, status: "accepted" });
    const msg = await redirectOf(decideApplicationMatchAction(fd({ matchId: MATCH, decision: "accepted" })));
    expect(decide).toHaveBeenCalledExactlyOnceWith(MATCH, "accepted");
    expect(msg).toBe(`REDIRECT:${ROUTE}?status=accepted`);
  });

  it("reject posts the same match id and 'rejected'", async () => {
    decide.mockResolvedValue({ ok: true, status: "rejected" });
    const msg = await redirectOf(decideApplicationMatchAction(fd({ matchId: MATCH, decision: "rejected" })));
    expect(decide).toHaveBeenCalledExactlyOnceWith(MATCH, "rejected");
    expect(msg).toBe(`REDIRECT:${ROUTE}?status=rejected`);
  });

  it("B16 — the route is revalidated, so the page that renders next is re-read rather than remembered", async () => {
    decide.mockResolvedValue({ ok: true, status: "accepted" });
    await redirectOf(decideApplicationMatchAction(fd({ matchId: MATCH, decision: "accepted" })));
    expect(revalidatePath).toHaveBeenCalledWith(ROUTE);
  });

  it("decides exactly ONE candidate per submission — there is no batch verb to reach", async () => {
    decide.mockResolvedValue({ ok: true, status: "accepted" });
    const form = fd({ matchId: MATCH, decision: "accepted" });
    form.append("matchId", "m2222222-2222-2222-2222-222222222222");
    await redirectOf(decideApplicationMatchAction(form));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0]).toBe(MATCH);
  });
});

describe("B14 / M2 — nothing can be decided that a human did not ask for", () => {
  it("a decision outside the two admitted values fails closed, with no command call", async () => {
    for (const decision of ["proposed", "", "ACCEPTED", "accept", "delete", "accepted; drop table"]) {
      decide.mockReset();
      const msg = await redirectOf(decideApplicationMatchAction(fd({ matchId: MATCH, decision })));
      expect(decide, `${decision} must not reach the command`).not.toHaveBeenCalled();
      expect(msg).toBe(`REDIRECT:${ROUTE}?status=invalid_decision`);
    }
  });

  it("a missing or blank match id fails closed, with no command call", async () => {
    for (const form of [fd({ decision: "accepted" }), fd({ matchId: "   ", decision: "accepted" })]) {
      decide.mockReset();
      const msg = await redirectOf(decideApplicationMatchAction(form));
      expect(decide).not.toHaveBeenCalled();
      expect(msg).toBe(`REDIRECT:${ROUTE}?status=invalid_decision`);
    }
  });

  it("a decision is never inferred from a missing field — an empty form decides nothing", async () => {
    const msg = await redirectOf(decideApplicationMatchAction(new FormData()));
    expect(decide).not.toHaveBeenCalled();
    expect(msg).toBe(`REDIRECT:${ROUTE}?status=invalid_decision`);
  });
});

describe("B7 / B8 / B9 / M6 — every bounded result reaches the page as itself", () => {
  it("settled, raced and refused results are all passed through", async () => {
    for (const status of ["already_decided", "already_accepted", "already_rejected", "already_proposed", "accepted_exists", "not_allowed", "invalid_decision"]) {
      decide.mockResolvedValue({ ok: true, status });
      const msg = await redirectOf(decideApplicationMatchAction(fd({ matchId: MATCH, decision: "accepted" })));
      expect(msg, `${status} must be reported as itself`).toBe(`REDIRECT:${ROUTE}?status=${status}`);
    }
  });

  it("a bounded failure becomes a status code, never a database message", async () => {
    for (const error of ["not_allowed", "query_failed"]) {
      decide.mockResolvedValue({ ok: false, error });
      const msg = await redirectOf(decideApplicationMatchAction(fd({ matchId: MATCH, decision: "accepted" })));
      expect(msg).toBe(`REDIRECT:${ROUTE}?status=${error}`);
    }
  });
});
