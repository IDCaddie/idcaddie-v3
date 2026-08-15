import { describe, it, expect } from "vitest";
import {
  buildReviewGroups,
  decideOutcome,
  DECIDE_STATUSES,
  DECISIONS,
  isDecideStatus,
  isDecision,
  isMatchStatus,
  MATCH_STATUSES,
  type MatchRow,
  type ReviewLabels,
} from "./application-match-review";

// Phase 18F-B — the properties of the review model that must not drift. Each block below is a way the surface could start
// answering the customer's question for them, and the assertion is what makes that fail loudly instead of shipping.

const APP_A = "aaaaaaaa-0000-0000-0000-000000000001";
const APP_B = "bbbbbbbb-0000-0000-0000-000000000002";
const APP_C = "cccccccc-0000-0000-0000-000000000003";
const DA_1 = "dddddddd-0000-0000-0000-000000000001";
const DA_2 = "dddddddd-0000-0000-0000-000000000002";
const PROD = "eeeeeeee-0000-0000-0000-000000000001";

const labels = (over: Partial<ReviewLabels> = {}): ReviewLabels => ({
  application: new Map([
    [DA_1, "Salesforce"],
    [DA_2, "Atlassian Jira"],
  ]),
  productOf: new Map([[DA_1, PROD]]),
  productName: new Map([[PROD, "Salesforce"]]),
  app: new Map([
    // Same product, two operational records. This is the shape the whole surface exists for.
    [APP_A, { recordLabel: "Salesforce", instanceLabel: "acme.my.salesforce.com" }],
    [APP_B, { recordLabel: "Salesforce", instanceLabel: "acme--sandbox.my.salesforce.com" }],
    [APP_C, { recordLabel: "Zoom", instanceLabel: null }],
  ]),
  ...over,
});

const row = (matchId: string, appId: string, status: MatchRow["status"], directoryApplicationId = DA_1): MatchRow => ({
  matchId,
  appId,
  status,
  directoryApplicationId,
});

describe("the decision vocabulary", () => {
  it("match states are exactly the three the table's CHECK constraint allows", () => {
    expect([...MATCH_STATUSES]).toEqual(["proposed", "accepted", "rejected"]);
    expect(isMatchStatus("proposed")).toBe(true);
    expect(isMatchStatus("superseded")).toBe(false);
  });

  it("a human may only accept or reject — `proposed` is a state, never a decision that can be posted", () => {
    expect([...DECISIONS]).toEqual(["accepted", "rejected"]);
    expect(isDecision("accepted")).toBe(true);
    expect(isDecision("rejected")).toBe(true);
    expect(isDecision("proposed")).toBe(false);
    expect(isDecision("")).toBe(false);
    expect(isDecision("ACCEPTED")).toBe(false);
  });

  it("an unrecognised result status is refused rather than passed through", () => {
    for (const s of DECIDE_STATUSES) expect(isDecideStatus(s)).toBe(true);
    expect(isDecideStatus("ERROR:  duplicate key value violates unique constraint")).toBe(false);
    expect(isDecideStatus("unknown")).toBe(false);
  });

  // M6 — treating a replayed decision as a failure. `already_rejected` (and its siblings) mean the row was settled before
  // this click; nothing is wrong, so nothing may be classified as a refusal.
  it("a settled or raced result is NOT a refusal", () => {
    expect(decideOutcome("accepted")).toBe("decided");
    expect(decideOutcome("rejected")).toBe("decided");
    expect(decideOutcome("already_decided")).toBe("settled");
    expect(decideOutcome("already_accepted")).toBe("settled");
    expect(decideOutcome("already_rejected")).toBe("settled");
    expect(decideOutcome("already_proposed")).toBe("settled");
    // A lost race is its own outcome: the winner is accepted, and THIS candidate is still a proposal.
    expect(decideOutcome("accepted_exists")).toBe("contended");
    expect(decideOutcome("not_allowed")).toBe("refused");
    expect(decideOutcome("invalid_decision")).toBe("refused");
  });

  it("only a caller being told no is a refusal", () => {
    const refused = DECIDE_STATUSES.filter((s) => decideOutcome(s) === "refused");
    expect([...refused]).toEqual(["not_allowed", "invalid_decision"]);
  });
});

describe("B1 — nothing proposed", () => {
  it("no match rows means no groups (and nothing invented to fill the page)", () => {
    expect(buildReviewGroups([], labels())).toEqual([]);
  });
});

describe("B2 — one candidate", () => {
  it("one proposal is one group with one open candidate and the upstream product recognition", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "proposed")], labels());
    expect(groups).toHaveLength(1);
    expect(groups[0].directoryApplicationId).toBe(DA_1);
    expect(groups[0].applicationLabel).toBe("Salesforce");
    expect(groups[0].productLabel).toBe("Salesforce");
    expect(groups[0].openCount).toBe(1);
    expect(groups[0].candidates).toHaveLength(1);
    expect(groups[0].candidates[0]).toMatchObject({ matchId: "m1", appId: APP_A, status: "proposed", ambiguous: false });
  });

  // A single candidate is exhaustive by CARDINALITY, not by evidence — so one candidate is still a question, never an answer.
  it("does not promote a lone candidate to accepted", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "proposed")], labels());
    expect(groups[0].candidates[0].status).toBe("proposed");
  });
});

describe("B3 / M7 — many candidates all survive", () => {
  it("three competing proposals produce three candidates in one group, none dropped or merged", () => {
    const groups = buildReviewGroups(
      [row("m1", APP_A, "proposed"), row("m2", APP_B, "proposed"), row("m3", APP_C, "proposed")],
      labels(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toHaveLength(3);
    expect(groups[0].candidates.map((c) => c.matchId).sort()).toEqual(["m1", "m2", "m3"]);
    expect(groups[0].openCount).toBe(3);
  });
});

describe("B4 / M1 — no candidate is ranked, preferred, or singled out", () => {
  const rows = [row("m2", APP_B, "proposed"), row("m1", APP_A, "proposed"), row("m3", APP_C, "proposed")];

  it("orders candidates by their own label, so arrival order cannot become a preference", () => {
    const groups = buildReviewGroups(rows, labels());
    // "Salesforce" (sandbox instance) sorts before "Salesforce" (production instance) by INSTANCE, and "Zoom" last. The point
    // is not the alphabet — it is that the order is a property of the labels and of nothing else.
    expect(groups[0].candidates.map((c) => c.matchId)).toEqual(["m2", "m1", "m3"]);
  });

  it("is independent of the order the rows arrive in", () => {
    const forward = buildReviewGroups(rows, labels()).map((g) => g.candidates.map((c) => c.matchId));
    const reversed = buildReviewGroups([...rows].reverse(), labels()).map((g) => g.candidates.map((c) => c.matchId));
    expect(reversed).toEqual(forward);
  });

  it("gives every candidate the SAME fields — there is no place to record a winner", () => {
    const groups = buildReviewGroups(rows, labels());
    const shapes = groups[0].candidates.map((c) => Object.keys(c).sort().join(","));
    expect(new Set(shapes).size).toBe(1);
    // Nothing that could carry a ranking exists on the model at all, so no renderer can read one.
    for (const c of groups[0].candidates) {
      for (const forbidden of ["confidence", "score", "rank", "recommended", "preferred", "best", "method"]) {
        expect(c, `a candidate must not carry ${forbidden}`).not.toHaveProperty(forbidden);
      }
    }
  });

  it("ties break on the match id, never on position, so the order is total and stable", () => {
    const same = labels({ app: new Map([[APP_A, { recordLabel: "Salesforce", instanceLabel: null }], [APP_B, { recordLabel: "Salesforce", instanceLabel: null }]]) });
    const groups = buildReviewGroups([row("m9", APP_B, "proposed"), row("m1", APP_A, "proposed")], same);
    expect(groups[0].candidates.map((c) => c.matchId)).toEqual(["m1", "m9"]);
  });
});

describe("indistinguishable records are reported, not hidden", () => {
  const indistinguishable = labels({
    app: new Map([
      [APP_A, { recordLabel: "Salesforce", instanceLabel: null }],
      [APP_B, { recordLabel: "Salesforce", instanceLabel: null }],
    ]),
  });

  it("two candidates a reader cannot tell apart are both flagged", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "proposed"), row("m2", APP_B, "proposed")], indistinguishable);
    expect(groups[0].candidates.map((c) => c.ambiguous)).toEqual([true, true]);
  });

  it("records that differ by instance are not flagged", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "proposed"), row("m2", APP_B, "proposed")], labels());
    expect(groups[0].candidates.every((c) => c.ambiguous === false)).toBe(true);
  });

  // THE SEPARATOR IS PART OF THE PROPERTY, not an implementation detail. The flag compares a COMPOSITE of two free-text
  // labels, so any separator that can itself occur inside a label makes distinguishable rows collide and marks them
  // "cannot be told apart" when they plainly can. Each pair below is the exact collision a common separator choice
  // produces, so swapping the separator for a space, a colon, a pipe, a comma or nothing at all turns one of them RED.
  //
  // U+0000 is the one separator that CANNOT occur in a label: Postgres refuses a NUL byte inside a `text` value, so no
  // name, domain, workspace address or instance id reaching this function can contain one. That is why the composite is
  // NUL-joined — and why the source must spell it as the six-character escape backslash-u-0000 rather than
  // embed the raw byte. A raw NUL makes grep classify the whole file as binary, and both check-auth-safety.sh and
  // check-app-runtime-imports.sh scan with `grep -I`, so the file would be silently skipped by both. The tripwire
  // that keeps every file in this lane spelled out lives in data/application-match-review.test.ts.
  it("distinguishable records never collide, whatever punctuation their labels contain", () => {
    const COLLIDES_UNDER: ReadonlyArray<readonly [string, readonly [string, string | null], readonly [string, string | null]]> = [
      ["a space", ["A B", "C"], ["A", "B C"]],
      ["a colon", ["A:B", "C"], ["A", "B:C"]],
      ["a pipe", ["A|B", "C"], ["A", "B|C"]],
      ["a comma", ["A,B", "C"], ["A", "B,C"]],
      ["no separator at all", ["AB", "C"], ["A", "BC"]],
      ["a newline", ["A\nB", "C"], ["A", "B\nC"]],
    ];
    for (const [what, first, second] of COLLIDES_UNDER) {
      const groups = buildReviewGroups(
        [row("m1", APP_A, "proposed"), row("m2", APP_B, "proposed")],
        labels({
          app: new Map([
            [APP_A, { recordLabel: first[0], instanceLabel: first[1] }],
            [APP_B, { recordLabel: second[0], instanceLabel: second[1] }],
          ]),
        }),
      );
      expect(
        groups[0].candidates.map((c) => c.ambiguous),
        `these two records are distinguishable; they would collide under ${what}`,
      ).toEqual([false, false]);
    }
  });

  it("still flags a genuinely identical pair — the guard above did not disable detection", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "proposed"), row("m2", APP_B, "proposed")], indistinguishable);
    expect(groups[0].candidates.map((c) => c.ambiguous)).toEqual([true, true]);
  });
});

describe("B7 / B8 / M14 — settled decisions survive assembly untouched", () => {
  it("an accepted candidate stays accepted and its siblings stay proposed", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "accepted"), row("m2", APP_B, "proposed")], labels());
    const byId = new Map(groups[0].candidates.map((c) => [c.matchId, c.status]));
    expect(byId.get("m1")).toBe("accepted");
    expect(byId.get("m2")).toBe("proposed");
    // The sibling was NOT swept to rejected by the acceptance — docs/79: it "remains a proposal".
    expect(groups[0].openCount).toBe(1);
  });

  it("a rejected candidate stays rejected and does not reject its product siblings (M3)", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "rejected"), row("m2", APP_B, "proposed")], labels());
    const byId = new Map(groups[0].candidates.map((c) => [c.matchId, c.status]));
    expect(byId.get("m1")).toBe("rejected");
    expect(byId.get("m2")).toBe("proposed");
    expect(groups[0].openCount).toBe(1);
  });

  it("never changes a status it was handed (no assembly step decides anything)", () => {
    const rows = [row("m1", APP_A, "proposed"), row("m2", APP_B, "accepted"), row("m3", APP_C, "rejected")];
    const groups = buildReviewGroups(rows, labels());
    const out = new Map(groups.flatMap((g) => g.candidates).map((c) => [c.matchId, c.status]));
    for (const r of rows) expect(out.get(r.matchId)).toBe(r.status);
  });

  it("a fully settled group still renders, with nothing open", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "accepted"), row("m2", APP_B, "rejected")], labels());
    expect(groups).toHaveLength(1);
    expect(groups[0].openCount).toBe(0);
    expect(groups[0].candidates).toHaveLength(2);
  });
});

describe("group ordering and missing labels", () => {
  it("puts applications with open questions first, then orders by name", () => {
    const groups = buildReviewGroups(
      [row("m1", APP_A, "accepted", DA_1), row("m2", APP_C, "proposed", DA_2)],
      labels({ application: new Map([[DA_1, "Salesforce"], [DA_2, "Atlassian Jira"]]) }),
    );
    // DA_2 is alphabetically first AND has the open question; DA_1 is settled. Both orderings agree here, so assert the
    // settled one is last, which is the part that distinguishes queue order from plain alphabetical.
    expect(groups.map((g) => g.applicationLabel)).toEqual(["Atlassian Jira", "Salesforce"]);
  });

  it("orders open groups among themselves by name", () => {
    const groups = buildReviewGroups(
      [row("m1", APP_A, "proposed", DA_1), row("m2", APP_C, "proposed", DA_2)],
      labels(),
    );
    expect(groups.map((g) => g.applicationLabel)).toEqual(["Atlassian Jira", "Salesforce"]);
  });

  it("an unlabelled application or record becomes null — never a uuid standing in as a name", () => {
    const groups = buildReviewGroups([row("m1", "unknown-app", "proposed", "unknown-da")], {
      application: new Map(),
      productOf: new Map(),
      productName: new Map(),
      app: new Map(),
    });
    expect(groups[0].applicationLabel).toBeNull();
    expect(groups[0].productLabel).toBeNull();
    expect(groups[0].candidates[0].recordLabel).toBeNull();
    expect(groups[0].candidates[0].instanceLabel).toBeNull();
  });

  it("a resolved product with no name read yields null rather than the product id", () => {
    const groups = buildReviewGroups([row("m1", APP_A, "proposed")], labels({ productName: new Map() }));
    expect(groups[0].productLabel).toBeNull();
  });

  it("does not borrow a product label from a candidate record", () => {
    // DA_2 resolved to NO confirmed product, but its candidate record belongs to one. Reading the candidate's product here
    // would put a recognition claim on screen that nothing settled — for a manual proposal those are different facts.
    const groups = buildReviewGroups([row("m1", APP_A, "proposed", DA_2)], labels());
    expect(groups[0].productLabel).toBeNull();
  });
});
