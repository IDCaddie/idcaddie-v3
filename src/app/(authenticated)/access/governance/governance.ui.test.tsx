// @vitest-environment jsdom
//
// Phase 18F Lane A — the rendered surface. These assert what a CUSTOMER can see and do, not implementation detail:
// every state renders something truthful, severity is never colour-only, actions are reachable by keyboard, and no
// internal identifier or enum reaches the page.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/data/cross-source-findings-reader", () => ({ loadCrossSourceFindings: vi.fn() }));

import Page from "./page";
import { loadCrossSourceFindings } from "@/lib/data/cross-source-findings-reader";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

const finding = (o: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Application needs identification",
  summary: "This directory application has not been matched to a recognized software product.",
  guidance: "Confirm which software product this application is before linking it to an operational record.",
  severityLabel: "Low", severityTone: "neutral", confidenceLabel: "Medium confidence",
  subjectKind: "Application", firstSeenLabel: "First seen 5 days ago", lifecycleLabel: "Ongoing",
  evidenceRows: [{ label: "Applications", value: "1" }],
  action: { label: "View application", href: "/directory/applications" },
  ...o,
});
const ok = (findings: unknown[], unreadable = 0, truncated = false) =>
  asMock(loadCrossSourceFindings).mockResolvedValue({
    ok: true, data: { findings, shown: findings.length, unreadable, truncated },
  });

describe("A2/A3/A4/A5 — states", () => {
  it("A4 renders a finding with its title, summary, guidance, evidence and action", async () => {
    ok([finding()]);
    render(await Page());
    expect(screen.getByRole("heading", { level: 2, name: "Application needs identification" })).toBeTruthy();
    expect(screen.getByText(/has not been matched to a recognized software product/)).toBeTruthy();
    expect(screen.getByText(/Confirm which software product/)).toBeTruthy();
    expect(screen.getByText("Applications:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View application" }).getAttribute("href")).toBe("/directory/applications");
  });

  it("A5 renders every finding, once each", async () => {
    ok([finding(), finding({ id: "22222222-2222-4222-8222-222222222222", title: "Application match needs review" })]);
    render(await Page());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("2 open findings.")).toBeTruthy();
  });

  it("A2 an empty estate says so plainly, with no error styling", async () => {
    ok([]);
    render(await Page());
    expect(screen.getByText("No open findings")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A3 a backend error is an alert, and never renders as 'no findings'", async () => {
    asMock(loadCrossSourceFindings).mockResolvedValue({ ok: false, error: "query_failed" });
    render(await Page());
    expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText("No open findings")).toBeNull();
  });

  it("A12 a denied caller sees a neutral not-available state, not an error and not data", async () => {
    asMock(loadCrossSourceFindings).mockResolvedValue({ ok: false, error: "forbidden" });
    render(await Page());
    expect(screen.getByText("Not available")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("dropped rows are surfaced — a short list never reads as a clean estate", async () => {
    ok([finding()], 2);
    render(await Page());
    expect(screen.getByText(/2 findings could not be displayed/)).toBeTruthy();
    expect(screen.getByText(/The list below is incomplete/)).toBeTruthy();
    // ...and the one readable finding is still shown rather than the whole page failing.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  // THE INVARIANT THIS PAGE EXISTS TO HOLD, and the exact case the original suite never asked for. Every row failed
  // its contract: nothing is readable, and the estate is NOT clean — we simply could not read it. Reporting that as
  // "no open findings" is the one output this page must never produce.
  it("EVERY row unreadable is a failure state, NOT the clean empty state", async () => {
    ok([], 5);
    render(await Page());
    expect(screen.getByRole("alert").textContent).toMatch(/could not be displayed/);
    expect(screen.getByRole("alert").textContent).toMatch(/5 findings could not be read/);
    expect(screen.queryByText("No open findings"), "a broken data contract is not a clean estate").toBeNull();
    expect(screen.queryByText(/Nothing is currently flagged/)).toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("a single unreadable row with nothing readable is still a failure state", async () => {
    ok([], 1);
    render(await Page());
    expect(screen.getByRole("alert").textContent).toMatch(/1 finding could not be read/);
    expect(screen.queryByText("No open findings")).toBeNull();
  });
});

// ══ THE HEADLINE COUNT ════════════════════════════════════════════════════════════════════════════════════════════
// The reader is bounded and runs no count query, so the page may state an exact number ONLY when it holds the whole
// set. Above the cap it says so instead of naming a total nobody measured.
describe("bounded count copy", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => finding({ id: `id-${i}` }));

  it("1 finding reads in the singular", async () => {
    ok(many(1));
    render(await Page());
    expect(screen.getByText("1 open finding.")).toBeTruthy();
  });

  it.each([2, 99, 100])("%i findings is stated exactly", async n => {
    ok(many(n));
    render(await Page());
    expect(screen.getByText(`${n} open findings.`)).toBeTruthy();
  });

  it("a truncated page says so and NEVER states the cap as the total", async () => {
    ok(many(100), 0, true);
    const { container } = render(await Page());
    expect(screen.getByText("Showing the 100 most severe of more than 100 open findings.")).toBeTruthy();
    expect(screen.queryByText("100 open findings."), "the cap is not the estate").toBeNull();
    expect(container.textContent).not.toMatch(/(^|[^n ])100 open findings\./);
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
  });
});

// ══ RENDER IDENTITY ═══════════════════════════════════════════════════════════════════════════════════════════════
// The reader's identity property was pinned; the RENDER key was not. These two tests fail for different mutations —
// the first when the key becomes copy (title/reason/remediation), the second when it becomes the array index — and
// together they are what makes "the same problem does not appear to vanish and come back" true on screen.
describe("A11 the rendered list is keyed on persisted finding identity", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("keeps the SAME row element when one finding changes remediation subtype", async () => {
    ok([finding({ id: ID, title: "Application needs identification" })]);
    const { container, rerender } = render(await Page());
    const before = container.querySelector("li");
    expect(before?.textContent).toContain("Application needs identification");

    // 0083 refreshes ONE row in place as the subtype moves; only the reviewed copy changes.
    ok([finding({ id: ID, title: "Application match needs review" })]);
    rerender(await Page());
    const after = container.querySelector("li");

    expect(after?.textContent).toContain("Application match needs review");
    expect(screen.getAllByRole("listitem"), "one finding, not two").toHaveLength(1);
    expect(after, "keying on copy would unmount this row and mount a different one").toBe(before);
  });

  it("carries the row element with the finding when severity ordering moves it", async () => {
    const A = "aaaaaaaa-1111-4111-8111-111111111111";
    const B = "bbbbbbbb-2222-4222-8222-222222222222";
    const nodeFor = (c: HTMLElement, t: string) =>
      [...c.querySelectorAll("li")].find(li => li.textContent?.includes(t));

    ok([finding({ id: A, title: "Alpha finding" }), finding({ id: B, title: "Beta finding" })]);
    const { container, rerender } = render(await Page());
    const betaBefore = nodeFor(container, "Beta finding");
    expect(betaBefore).toBeTruthy();

    // A re-evaluation can change severity and reorder the list. The row must travel with its finding.
    ok([finding({ id: B, title: "Beta finding" }), finding({ id: A, title: "Alpha finding" })]);
    rerender(await Page());

    expect(nodeFor(container, "Beta finding"), "keying on the array index rewrites rows in place instead of moving them")
      .toBe(betaBefore);
  });
});

describe("A6/A7/A8 — the three remediations, and the Lane B boundary", () => {
  it("renders each subtype's own copy", async () => {
    ok([
      finding({ id: "a", title: "Application needs identification" }),
      finding({ id: "b", title: "Application is not linked to an operational record" }),
      finding({ id: "c", title: "Application match needs review" }),
    ]);
    render(await Page());
    for (const t of ["Application needs identification", "Application is not linked to an operational record",
                     "Application match needs review"]) {
      expect(screen.getByRole("heading", { level: 2, name: t })).toBeTruthy();
    }
  });

  // A4 of the brief: a missing Lane B route must not become a broken link.
  it("A8 a finding with no available action renders an honest note, NOT a link", async () => {
    ok([finding({ title: "Application match needs review", action: null })]);
    render(await Page());
    expect(screen.queryByRole("link", { name: /Review available matches/ })).toBeNull();
    expect(screen.getByText(/A dedicated review screen is not available yet/)).toBeTruthy();
  });

  it("every rendered action points somewhere, and no link href is empty or '#'", async () => {
    ok([finding(), finding({ id: "b", action: { label: "View application accounts", href: "/saas/accounts" } })]);
    render(await Page());
    for (const a of screen.getAllByRole("link")) {
      const href = a.getAttribute("href") ?? "";
      expect(href.length).toBeGreaterThan(0);
      expect(href).not.toBe("#");
    }
  });
});

describe("A9/A13 — lifecycle and identifiers", () => {
  it("A9 a returned finding is labelled, not silently identical to a new one", async () => {
    ok([finding({ lifecycleLabel: "Returned" })]);
    render(await Page());
    expect(screen.getByText("Returned")).toBeTruthy();
  });

  it("A13 no raw UUID appears anywhere in the rendered page", async () => {
    ok([finding()]);
    const { container } = render(await Page());
    expect(container.textContent ?? "").not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it("no internal enum or copy key is rendered", async () => {
    ok([finding()]);
    const { container } = render(await Page());
    const text = container.textContent ?? "";
    for (const internal of ["crossSource.", "product_unresolved", "operational_instance_absent",
                            "operational_match_unaccepted", "discovered_application_unmanaged_by_idp", "cross_source"]) {
      expect(text, `leaked ${internal}`).not.toContain(internal);
    }
  });
});

describe("A8/A14/A15 — accessibility and layout contract", () => {
  it("A15 severity is communicated by a WORD, not colour alone", async () => {
    ok([finding({ severityLabel: "High", severityTone: "danger" })]);
    render(await Page());
    // The word is present in the accessible text, so a screen reader and a colour-blind user both get the signal.
    expect(screen.getByText("High")).toBeTruthy();
  });

  // Three bare adjectives in a row read aloud as "High Application account Ongoing", which names no dimension. The
  // prefixes are sr-only, so the visual pill layout is unchanged.
  it("A15 each badge names the DIMENSION it describes, for a screen reader", async () => {
    ok([finding({ severityLabel: "High", severityTone: "danger", subjectKind: "Person", lifecycleLabel: "Returned" })]);
    const { container } = render(await Page());
    const badgeLabels = [...container.querySelectorAll("span.sr-only")].map(s => s.textContent?.trim());
    for (const dimension of ["Severity:", "Subject:", "Lifecycle:"]) {
      expect(badgeLabels, `no programmatic label for ${dimension}`).toContain(dimension);
    }
  });

  // Muted text must define a dark value; `text-zinc-500` alone falls below AA on the dark page background.
  it("A14 every muted text class pairs a dark-mode value", async () => {
    ok([finding({ action: null })]);
    const { container } = render(await Page());
    for (const el of container.querySelectorAll("[class*='text-zinc-500']")) {
      expect(el.className, `un-paired muted text: ${el.className}`).toMatch(/dark:text-zinc-/);
    }
  });

  it("headings nest correctly: one h1, an h2 per finding", async () => {
    ok([finding(), finding({ id: "b" })]);
    render(await Page());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("the list has a real list structure and an accessible name", async () => {
    ok([finding()]);
    render(await Page());
    const list = screen.getByRole("list", { name: "Cross-system governance findings" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("A15 the action is a native link — keyboard reachable, with a visible focus style", async () => {
    ok([finding()]);
    render(await Page());
    const link = screen.getByRole("link", { name: "View application" });
    expect(link.tagName).toBe("A");                       // natively focusable; no tabindex juggling
    expect(link.className).toMatch(/focus-visible:/);     // focus is visible, not suppressed
  });

  it("A14 layout classes wrap rather than forcing horizontal scroll on a narrow viewport", async () => {
    ok([finding()]);
    const { container } = render(await Page());
    const rows = container.querySelectorAll(".flex.flex-wrap");
    expect(rows.length).toBeGreaterThan(0);
    expect(container.querySelector(".overflow-x-scroll")).toBeNull();
  });

  it("no information is conveyed by hover alone (no title-attribute-only content)", async () => {
    ok([finding()]);
    const { container } = render(await Page());
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
  });
});
