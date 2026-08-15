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
const ok = (findings: unknown[], unreadable = 0) =>
  asMock(loadCrossSourceFindings).mockResolvedValue({ ok: true, data: { findings, total: findings.length, unreadable } });

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
