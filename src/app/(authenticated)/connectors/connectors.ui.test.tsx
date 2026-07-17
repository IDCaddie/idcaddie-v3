// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

// P5E17 — the customer connector MARKETPLACE (the replaced /connectors page). Proves: real catalog → safe customer cards,
// Okta is preview-connectable, unbuilt providers show "Coming soon", search + status + category filters work, the operator
// sync-review link is preserved, and NO internal governance wording leaks. The catalog reads the server-only provider
// registry, so we mock the registry (isConnectorProviderReady=false reproduces production: nothing is live).
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/server/connector-vault/provider-registry", () => ({
  getConnectorProvider: () => null,
  isConnectorProviderReady: () => false, // every provider inert today — reproduces production
}));

import ConnectorsPage from "./page";

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

async function renderPage() {
  return render(await ConnectorsPage());
}

describe("/connectors marketplace", () => {
  it("renders the real catalog as safe customer cards; Okta is connectable, unbuilt providers are Coming soon", async () => {
    const { container } = await renderPage();
    // Okta card: connectable preview → its CTA label is "Connect Okta"
    expect(screen.getByText("Connect Okta")).toBeTruthy();
    // A not-yet-built provider (Salesforce) is present as "Coming soon" (there are several; assert at least one)
    expect(screen.getByText("Salesforce")).toBeTruthy();
    expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(0);
    // 12 curated providers → 12 cards
    expect(container.querySelectorAll("ul li").length).toBeGreaterThanOrEqual(12);
  });

  it("shows the compact P5E17b header copy + preview note", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Connectors" })).toBeTruthy();
    expect(screen.getByText("Connect your business apps to discover users, access, and software usage.")).toBeTruthy();
    expect(screen.getByText("Preview connectors do not import data.")).toBeTruthy();
    // the old long defensive copy is gone
    expect(screen.queryByText(/nothing syncs until a connection is fully ready/)).toBeNull();
  });

  it("Okta card has a strong CTA and at most two capability chips; coming-soon cards are muted + disabled", async () => {
    const { container } = await renderPage();
    // Okta capability chips reduced to two (Users, Account status)
    const oktaCard = screen.getByText("Okta").closest("a");
    expect(oktaCard).not.toBeNull();
    const chips = (oktaCard as HTMLElement).querySelectorAll("span.rounded.border");
    expect(chips.length).toBeLessThanOrEqual(2);
    // a coming-soon card's CTA is marked disabled (muted, non-interactive)
    const sf = screen.getByText("Salesforce").closest("div");
    const disabledCta = container.querySelector('[aria-disabled="true"]');
    expect(disabledCta?.textContent).toBe("Coming soon");
    expect(sf).not.toBeNull();
  });

  it("preserves the operator sync-review link and introduces no run/connect server action", async () => {
    await renderPage();
    const review = screen.getByRole("link", { name: "Go to sync review" });
    expect(review.getAttribute("href")).toBe("/connectors/review");
    // marketplace is browse-only: filter controls are buttons, but there is no form/submit that mutates anything
    expect(document.querySelector("form")).toBeNull();
  });

  it("leaks no internal governance wording", async () => {
    const { container } = await renderPage();
    const text = (container.textContent ?? "").toLowerCase();
    for (const forbidden of [
      "certificationonly", "certification only", "risk-007", "execution authorization", "credential reference",
      "tenant binding", "kill switch", "promotion", "canonical", "connector runner", "task definition", "task-def",
      "credential", "secret", "token", "ecs task",
    ]) {
      expect(text.includes(forbidden), `should not surface "${forbidden}"`).toBe(false);
    }
  });

  it("search filters by name and shows the empty state for no matches", async () => {
    await renderPage();
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "okta" } });
    expect(screen.getByText("Okta")).toBeTruthy();
    expect(screen.queryByText("Salesforce")).toBeNull();
    fireEvent.change(search, { target: { value: "zzznope" } });
    expect(screen.getByText("No connectors match your search")).toBeTruthy();
  });

  it("status + category filters narrow the grid", async () => {
    await renderPage();
    // Category: Identity → Okta + Microsoft Entra ID only
    fireEvent.click(screen.getByRole("button", { name: "Identity" }));
    expect(screen.getByText("Okta")).toBeTruthy();
    expect(screen.getByText("Microsoft Entra ID")).toBeTruthy();
    expect(screen.queryByText("Salesforce")).toBeNull();
    // Reset, then status: Coming soon → hides the preview-available providers (Okta)
    fireEvent.click(screen.getByRole("button", { name: "All categories" }));
    fireEvent.click(screen.getByRole("button", { name: "Coming soon" }));
    expect(screen.queryByText("Okta")).toBeNull();
    expect(screen.getByText("Salesforce")).toBeTruthy();
  });

  it("a connectable card is a link to its detail route; a coming-soon card is inert", async () => {
    await renderPage();
    const oktaLink = screen.getByRole("link", { name: /^Okta —/ });
    expect(oktaLink.getAttribute("href")).toBe("/connectors/okta");
    // Salesforce (coming soon) renders no link/href to a connect flow
    const sf = screen.getByText("Salesforce").closest("li");
    expect(sf && within(sf as HTMLElement).queryByRole("link")).toBeNull();
  });
});
