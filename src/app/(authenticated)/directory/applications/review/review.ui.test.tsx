// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}));
vi.mock("@/lib/data/application-match-review", () => ({ loadApplicationMatchReview: vi.fn() }));
vi.mock("./actions", () => ({ decideApplicationMatchAction: vi.fn() }));

import ApplicationMatchReviewPage from "./page";
import { loadApplicationMatchReview } from "@/lib/data/application-match-review";
import type { MatchCandidateView, ReviewGroupView } from "@/lib/canonical/application-match-review";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

const MATCH_A = "aaaa1111-1111-1111-1111-111111111111";
const MATCH_B = "bbbb2222-2222-2222-2222-222222222222";
const MATCH_C = "cccc3333-3333-3333-3333-333333333333";
const APP_A = "1111aaaa-1111-1111-1111-111111111111";
const APP_B = "2222bbbb-2222-2222-2222-222222222222";
const APP_C = "3333cccc-3333-3333-3333-333333333333";
const DA = "dddd0000-0000-0000-0000-000000000001";

const candidate = (over: Partial<MatchCandidateView> = {}): MatchCandidateView => ({
  matchId: MATCH_A,
  appId: APP_A,
  recordLabel: "Salesforce",
  instanceLabel: "acme.my.salesforce.com",
  status: "proposed",
  ambiguous: false,
  ...over,
});

const group = (over: Partial<ReviewGroupView> = {}): ReviewGroupView => ({
  directoryApplicationId: DA,
  applicationLabel: "Salesforce",
  productLabel: "Salesforce",
  openCount: 1,
  candidates: [candidate()],
  ...over,
});

const setQueue = (groups: readonly ReviewGroupView[]) =>
  asMock(loadApplicationMatchReview).mockResolvedValue({ ok: true, data: { groups } });
const setError = (error: "not_allowed" | "query_failed") =>
  asMock(loadApplicationMatchReview).mockResolvedValue({ ok: false, error });

const render_ = (sp: Record<string, string> = {}) => ApplicationMatchReviewPage({ searchParams: Promise.resolve(sp) });

// Three competing records for ONE application — the shape this whole surface exists for.
const THREE = group({
  openCount: 3,
  candidates: [
    candidate({ matchId: MATCH_A, appId: APP_A, recordLabel: "Salesforce", instanceLabel: "acme.my.salesforce.com" }),
    candidate({ matchId: MATCH_B, appId: APP_B, recordLabel: "Salesforce", instanceLabel: "acme--sandbox.my.salesforce.com" }),
    candidate({ matchId: MATCH_C, appId: APP_C, recordLabel: "Salesforce", instanceLabel: "acme--uat.my.salesforce.com" }),
  ],
});

// Buttons specifically — the page also NAMES "Not this record" in its explanatory copy, and a text query would count that
// sentence as a control.
const acceptButtons = () => screen.queryAllByRole("button", { name: "Accept this record" });
const rejectButtons = () => screen.queryAllByRole("button", { name: "Not this record" });
// The decision banner, which is the only element that reports a `?status=` code.
const bannerOf = (c: HTMLElement) => c.querySelector("div.rounded.border.p-3");

describe("B1 — nothing waiting", () => {
  it("says so plainly and offers no controls", async () => {
    setQueue([]);
    render(await render_());
    expect(screen.getByText("No application is waiting on a match decision.")).toBeTruthy();
    expect(acceptButtons()).toHaveLength(0);
    expect(rejectButtons()).toHaveLength(0);
  });

  it("does not claim the software is unmanaged or that anything is wrong", async () => {
    setQueue([]);
    const { container } = render(await render_());
    const text = (container.textContent ?? "").toLowerCase();
    for (const wrong of ["unmanaged", "error", "problem", "failed"]) expect(text).not.toContain(wrong);
  });
});

describe("B2 — one candidate", () => {
  it("shows the application, its recognised product, the record and its instance", async () => {
    setQueue([group()]);
    render(await render_());
    expect(screen.getByRole("heading", { level: 2, name: "Salesforce" })).toBeTruthy();
    expect(screen.getByText(/Recognised as/)).toBeTruthy();
    expect(screen.getByText("acme.my.salesforce.com")).toBeTruthy();
    expect(acceptButtons()).toHaveLength(1);
    expect(rejectButtons()).toHaveLength(1);
  });

  it("names the record, and links it so the customer can go and look at it", async () => {
    setQueue([group()]);
    const { container } = render(await render_());
    const link = container.querySelector(`a[href="/apps/${APP_A}"]`);
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe("Salesforce");
  });

  it("uses no identifier as a visible label", async () => {
    setQueue([group()]);
    const { container } = render(await render_());
    for (const id of [MATCH_A, APP_A, DA]) expect(container.textContent).not.toContain(id);
  });

  it("does not pre-select, pre-tick or default a decision", async () => {
    setQueue([group()]);
    const { container } = render(await render_());
    expect(container.querySelectorAll("input[checked]")).toHaveLength(0);
    expect(container.querySelectorAll("[selected]")).toHaveLength(0);
    // The two hidden fields carry the candidate and the verb — nothing else, and no tenant.
    const names = [...container.querySelectorAll("input")].map((i) => i.getAttribute("name"));
    expect(new Set(names)).toEqual(new Set(["matchId", "decision"]));
    expect(container.innerHTML).not.toContain('name="tenantId"');
    expect(container.innerHTML).not.toContain('name="matchIds"');
  });
});

describe("B3 / B4 / M1 / M7 — many candidates, treated equally", () => {
  it("renders every competing record — none collapsed away", async () => {
    setQueue([THREE]);
    const { container } = render(await render_());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(screen.getByText("acme.my.salesforce.com")).toBeTruthy();
    expect(screen.getByText("acme--sandbox.my.salesforce.com")).toBeTruthy();
    expect(screen.getByText("acme--uat.my.salesforce.com")).toBeTruthy();
  });

  it("gives every candidate its own accept and reject control", async () => {
    setQueue([THREE]);
    render(await render_());
    expect(acceptButtons()).toHaveLength(3);
    expect(rejectButtons()).toHaveLength(3);
  });

  it("styles every candidate row identically — there is no emphasised row", async () => {
    setQueue([THREE]);
    const { container } = render(await render_());
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(new Set(rows.map((r) => r.className)).size).toBe(1);
    // and the cells inside them, so a first-row-only style cannot hide one level down
    const cellClasses = rows.map((r) => [...r.querySelectorAll("td")].map((c) => c.className).join("|"));
    expect(new Set(cellClasses).size).toBe(1);
  });

  it("renders the candidates in the order it was given, adding no ordering of its own", async () => {
    setQueue([THREE]);
    const { container } = render(await render_());
    const instances = [...container.querySelectorAll("tbody tr")].map((r) => r.querySelectorAll("td")[1]?.textContent);
    expect(instances).toEqual([
      "acme.my.salesforce.com",
      "acme--sandbox.my.salesforce.com",
      "acme--uat.my.salesforce.com",
    ]);
  });

  it("shows no ranking, score or preference language anywhere", async () => {
    setQueue([THREE]);
    const { container } = render(await render_());
    const text = (container.textContent ?? "").toLowerCase();
    for (const banned of ["recommended", "best match", "most likely", "confidence", "likely match", "top match", "suggested", "probably", "% match"]) {
      expect(text, `must not say "${banned}"`).not.toContain(banned);
    }
  });

  it("says out loud that the list is in no order of preference", async () => {
    setQueue([THREE]);
    render(await render_());
    expect(screen.getByText(/in no order of preference/)).toBeTruthy();
  });

  it("marks records the customer's own data cannot tell apart, and only those", async () => {
    const same = group({
      openCount: 2,
      candidates: [
        candidate({ matchId: MATCH_A, appId: APP_A, instanceLabel: null, ambiguous: true }),
        candidate({ matchId: MATCH_B, appId: APP_B, instanceLabel: null, ambiguous: true }),
      ],
    });
    setQueue([same]);
    const { container } = render(await render_());
    expect(container.textContent).toContain(`#${MATCH_A.slice(0, 8)}`);
    expect(container.textContent).toContain(`#${MATCH_B.slice(0, 8)}`);
    cleanup();
    setQueue([THREE]);
    const plain = render(await render_());
    expect(plain.container.textContent).not.toContain("#");
  });
});

describe("B15 / M3 — rejection is scoped to ONE record", () => {
  it("labels the control 'Not this record', never 'reject this application'", async () => {
    setQueue([THREE]);
    const { container } = render(await render_());
    expect(rejectButtons()).toHaveLength(3);
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("reject this application");
    expect(text).not.toContain("reject all");
    expect(text).not.toContain("not this product");
    expect(text).not.toContain("not this software");
  });

  it("states that rejecting a record says nothing about the recognised software, and leaves the others open", async () => {
    setQueue([THREE]);
    render(await render_());
    expect(screen.getByText(/it never says the application is not the/)).toBeTruthy();
    expect(screen.getByText(/every other record for that software stays an open question/)).toBeTruthy();
  });

  it("the reject banner is instance-scoped too", async () => {
    setQueue([group()]);
    render(await render_({ status: "rejected" }));
    expect(screen.getByText(/not that operational record/)).toBeTruthy();
    expect(screen.getByText(/still an open question/)).toBeTruthy();
  });
});

describe("B7 / B8 — a settled decision renders as settled", () => {
  it("an accepted record shows as accepted, with no controls, and its siblings stay open", async () => {
    setQueue([
      group({
        openCount: 1,
        candidates: [
          candidate({ matchId: MATCH_A, appId: APP_A, status: "accepted" }),
          candidate({ matchId: MATCH_B, appId: APP_B, instanceLabel: "acme--sandbox.my.salesforce.com", status: "proposed" }),
        ],
      }),
    ]);
    const { container } = render(await render_());
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.getByText("Awaiting your decision")).toBeTruthy();
    // exactly ONE candidate is still actionable — the accepted one offers nothing
    expect(acceptButtons()).toHaveLength(1);
    expect(rejectButtons()).toHaveLength(1);
    expect(screen.getByText(/Settled — kept as a record of the decision/)).toBeTruthy();
    // the sibling was not swept away
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("a rejected record shows as rejected and keeps no controls", async () => {
    setQueue([group({ openCount: 0, candidates: [candidate({ status: "rejected" })] })]);
    render(await render_());
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(acceptButtons()).toHaveLength(0);
    expect(rejectButtons()).toHaveLength(0);
  });

  it("a fully settled application still appears rather than vanishing", async () => {
    setQueue([
      group({
        openCount: 0,
        candidates: [candidate({ matchId: MATCH_A, status: "accepted" }), candidate({ matchId: MATCH_B, appId: APP_B, status: "rejected" })],
      }),
    ]);
    const { container } = render(await render_());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
  });

  it("offers nothing that would re-run matching or re-open a decision", async () => {
    setQueue([THREE]);
    const { container } = render(await render_());
    const text = (container.textContent ?? "").toLowerCase();
    for (const banned of ["re-run", "rerun", "run again", "check again", "refresh matches", "recalculate", "undo", "re-open", "reopen", "change decision"]) {
      expect(text, `must not offer "${banned}"`).not.toContain(banned);
    }
    // the only submit controls on the page are the per-candidate decisions
    expect(container.querySelectorAll("button")).toHaveLength(6);
  });
});

describe("B9 / M6 — a raced or replayed decision is reported truthfully, not as a failure", () => {
  it("the loser of a concurrent acceptance is told plainly that nothing changed", async () => {
    setQueue([group()]);
    const { container } = render(await render_({ status: "accepted_exists" }));
    expect(screen.getByText(/was accepted first, so nothing changed/)).toBeTruthy();
    expect(screen.getByText(/still awaiting a decision/)).toBeTruthy();
    // reported as ordinary, not as an error
    expect(container.querySelector(".border-red-300")).toBeNull();
  });

  it("a replayed decision reads as 'already decided', not as an error", async () => {
    for (const status of ["already_decided", "already_accepted", "already_rejected"]) {
      cleanup();
      setQueue([group()]);
      const { container } = render(await render_({ status }));
      expect(screen.getByText(/had already been decided, so nothing changed/), status).toBeTruthy();
      expect(container.querySelector(".border-red-300"), status).toBeNull();
    }
  });

  it("a candidate still open is reported as such", async () => {
    setQueue([group()]);
    render(await render_({ status: "already_proposed" }));
    expect(screen.getByText(/still awaiting a decision, so nothing changed/)).toBeTruthy();
  });

  it("a refusal IS shown as a problem", async () => {
    setQueue([group()]);
    const { container } = render(await render_({ status: "not_allowed" }));
    expect(container.querySelector(".border-red-300")).toBeTruthy();
    expect(screen.getByText(/needs an owner or administrator role/)).toBeTruthy();
  });
});

describe("M8 — no database detail ever reaches the screen", () => {
  it("an unrecognised status code renders no banner at all", async () => {
    setQueue([group()]);
    const { container } = render(await render_({ status: 'duplicate key value violates unique constraint "application_matches_one_accepted_dir_idx"' }));
    expect(bannerOf(container)).toBeNull();
    const text = container.textContent ?? "";
    for (const leak of ["duplicate key", "constraint", "application_matches", "violates"]) {
      expect(text, `must not surface ${leak}`).not.toContain(leak);
    }
  });

  it("a failed load says so in the customer's terms", async () => {
    setError("query_failed");
    const { container } = render(await render_());
    expect(screen.getByText(/Could not load the match review list right now/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/permission denied|relation|pg_|SQLSTATE/);
  });

  it("a repeated status parameter (a crafted query string) is ignored rather than rendered", async () => {
    setQueue([group()]);
    // Next hands a repeated query parameter over as an array; only a single string is ever read.
    const { container } = render(
      await ApplicationMatchReviewPage({ searchParams: Promise.resolve({ status: ["accepted", "not_allowed"] }) }),
    );
    expect(bannerOf(container)).toBeNull();
  });

  it("no banner is shown when no decision was just made", async () => {
    setQueue([group()]);
    const { container } = render(await render_());
    expect(bannerOf(container)).toBeNull();
  });
});

describe("B10 / B11 / M5 — editor and viewer see no queue and no controls", () => {
  it("explains the role needed and renders nothing to act on", async () => {
    setError("not_allowed");
    const { container } = render(await render_());
    expect(screen.getByText(/needs an owner or administrator role in this workspace/)).toBeTruthy();
    expect(acceptButtons()).toHaveLength(0);
    expect(rejectButtons()).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("never tells them the queue is empty — that would be a false statement about a list they cannot see", async () => {
    setError("not_allowed");
    const { container } = render(await render_());
    expect(container.textContent).not.toContain("No application is waiting on a match decision.");
  });
});

describe("the upstream product recognition", () => {
  it("says the software is already settled and only the record is open", async () => {
    setQueue([group()]);
    render(await render_());
    expect(screen.getByText(/that much is already settled/)).toBeTruthy();
    expect(screen.getByText(/What is open is which record below it is/)).toBeTruthy();
  });

  it("says so honestly when nothing has settled the software", async () => {
    setQueue([group({ productLabel: null })]);
    render(await render_());
    expect(screen.getByText("The software behind this application has not been settled from a confirmed identifier.")).toBeTruthy();
    expect(screen.queryByText(/Recognised as/)).toBeNull();
  });

  it("an application its provider no longer lists is named as such, never by its identifier", async () => {
    setQueue([group({ applicationLabel: null })]);
    const { container } = render(await render_());
    expect(screen.getByRole("heading", { level: 2, name: "Application no longer listed by your provider" })).toBeTruthy();
    expect(container.textContent).not.toContain(DA);
  });

  it("an unnamed record still renders a decidable row", async () => {
    setQueue([group({ candidates: [candidate({ recordLabel: null, instanceLabel: null })] })]);
    render(await render_());
    expect(screen.getByText("Unnamed record")).toBeTruthy();
    expect(acceptButtons()).toHaveLength(1);
  });
});

describe("B16 — the same data renders the same page", () => {
  it("is deterministic across renders, so a refresh shows the same queue", async () => {
    setQueue([THREE]);
    const first = render(await render_()).container.innerHTML;
    cleanup();
    setQueue([THREE]);
    const second = render(await render_()).container.innerHTML;
    expect(second).toBe(first);
  });

  it("a decision banner does not change the queue that is rendered beneath it", async () => {
    setQueue([THREE]);
    const plain = render(await render_()).container.querySelectorAll("tbody tr").length;
    cleanup();
    setQueue([THREE]);
    const afterDecision = render(await render_({ status: "accepted" })).container.querySelectorAll("tbody tr").length;
    expect(afterDecision).toBe(plain);
  });
});

// ── source posture ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

describe("the page itself queries nothing and mutates nothing", () => {
  it("holds no client, no tenant id and no table access", () => {
    const code = read("page.tsx").replace(/\/\/.*$/gm, "");
    for (const f of ["createClient", "activeTenant", ".from(", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete(", '"use server"']) {
      expect(code, `page.tsx must not contain ${f}`).not.toContain(f);
    }
  });

  it("reaches the database only through the gated loader and the one server action", () => {
    const imports = read("page.tsx").split("\n").filter((l) => l.startsWith("import"));
    expect(imports.some((l) => l.includes('from "@/lib/data/application-match-review"'))).toBe(true);
    expect(imports.some((l) => l.includes('from "./actions"'))).toBe(true);
    expect(imports.some((l) => /supabase/i.test(l))).toBe(false);
  });

  it("the action module is the only file in this route that is a server boundary", () => {
    expect(read("actions.ts")).toContain('"use server"');
    expect(read("page.tsx")).not.toContain('"use server"');
  });

  // ── the one way in ──────────────────────────────────────────────────────────────────────────────────────────────────
  // This surface has NO nav entry (nav-items.test.ts pins the Directory section to three labels), so the parent list
  // page's footnote link is the only path to it in the whole product. That footnote is now a SHARED surface: Lane A
  // (#431) merged first and rewrote the same sentences to say linking is decided by cross-system governance, and this
  // branch was rebased onto that, resolving both intents into one paragraph.
  //
  // Lane A's own test pins ITS half — reintroducing "not a problem to fix", or dropping the governance sentence, turns
  // `directory.ui.test.tsx` red. Nothing pinned THIS half: deleting the link left every suite in the repository green
  // while orphaning the route, which mutation testing of the resolution is how we found out. Asserted here, in this
  // lane's own file, rather than by editing the shared directory test.
  it("the parent applications page still links here — this is the only entry point that exists", () => {
    const parent = read("../page.tsx");
    expect(parent, "the review queue would be unreachable").toContain('href="/directory/applications/review"');
    expect(parent).toContain("application match review");
  });
});
