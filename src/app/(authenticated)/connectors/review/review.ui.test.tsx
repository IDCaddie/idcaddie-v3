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
vi.mock("@/lib/auth/tenant-context", () => ({ resolveTenantContext: vi.fn() }));
vi.mock("@/lib/data/sync-review", () => ({ getSyncReviewCounts: vi.fn(), getSyncReviewPendingGroups: vi.fn() }));
vi.mock("./actions", () => ({ confirmReviewBatchAction: vi.fn(), rejectReviewBatchAction: vi.fn() }));

import SyncReviewPage from "./page";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { getSyncReviewCounts, getSyncReviewPendingGroups } from "@/lib/data/sync-review";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
afterEach(cleanup);

const COUNTS = { ok: true, data: { pending: 3, needsReview: 0, confirmed: 0, rejected: 0, total: 3, appUserAccounts: 3 } };
const GROUP = { sourceRunId: "run-1abcdef0", factType: "app_user_account", provider: "slack", pending: 3, firstSeen: "2026-07-10T01:00:00Z", lastSeen: "2026-07-10T02:00:00Z" };
const setRole = (role: string | null) => asMock(resolveTenantContext).mockResolvedValue(role ? { activeTenant: { role } } : { activeTenant: null });
const render_ = (sp: Record<string, string> = {}) => SyncReviewPage({ searchParams: Promise.resolve(sp) });

describe("/connectors/review", () => {
  it("EDITOR sees confirm/reject controls + the fixed reason enum, with count-only batch data (no bodies/PII)", async () => {
    setRole("editor");
    asMock(getSyncReviewCounts).mockResolvedValue(COUNTS);
    asMock(getSyncReviewPendingGroups).mockResolvedValue({ ok: true, data: [GROUP] });

    const { container } = render(await render_());
    expect(screen.getByText("Sync review")).toBeTruthy();
    // batch metadata (safe only)
    expect(screen.getByText("slack")).toBeTruthy();
    expect(screen.getByText("App user accounts")).toBeTruthy();
    expect(screen.getByText("run-1abc")).toBeTruthy(); // truncated opaque run id
    // editor controls + reason enum
    expect(screen.getByText("Confirm pending")).toBeTruthy();
    expect(screen.getByText("Reject pending")).toBeTruthy();
    expect(screen.getByText("Not a real account")).toBeTruthy(); // a fixed reason option
    // batch scope carried as run+type only — NEVER a fact-id input
    const html = container.innerHTML;
    expect(html).toContain('name="sourceRunId"');
    expect(html).toContain('name="factType"');
    expect(html).not.toContain('name="factId"');
    expect(html).not.toContain('name="ids"');
    // no leaked body/PII
    for (const forbidden of ["fact_json", "natural_key", "signal_id", "@example.com", "leak"]) {
      expect(container.textContent?.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("VIEWER sees the read-only counts/batches but NO mutation controls", async () => {
    setRole("viewer");
    asMock(getSyncReviewCounts).mockResolvedValue(COUNTS);
    asMock(getSyncReviewPendingGroups).mockResolvedValue({ ok: true, data: [GROUP] });

    render(await render_());
    expect(screen.getByText("slack")).toBeTruthy(); // counts/batches still visible
    expect(screen.getByText(/read-only access/)).toBeTruthy();
    expect(screen.queryByText("Confirm pending")).toBeNull();
    expect(screen.queryByText("Reject pending")).toBeNull();
  });

  it("empty state when nothing is awaiting review", async () => {
    setRole("editor");
    asMock(getSyncReviewCounts).mockResolvedValue({ ok: true, data: { ...COUNTS.data, pending: 0, total: 0, appUserAccounts: 0 } });
    asMock(getSyncReviewPendingGroups).mockResolvedValue({ ok: true, data: [] });
    render(await render_());
    expect(screen.getByText("No items awaiting review.")).toBeTruthy();
    expect(screen.queryByText("Confirm pending")).toBeNull();
  });

  it("renders a safe result banner from ?status (success + fail-closed) and never a raw error/id", async () => {
    setRole("editor");
    asMock(getSyncReviewCounts).mockResolvedValue(COUNTS);
    asMock(getSyncReviewPendingGroups).mockResolvedValue({ ok: true, data: [GROUP] });
    render(await render_({ status: "confirmed_3" }));
    expect(screen.getByText("Confirmed 3 items.")).toBeTruthy();
    cleanup();
    render(await render_({ status: "invalid_reason" }));
    expect(screen.getByText(/choose a valid reason/)).toBeTruthy();
    cleanup();
    render(await render_({ status: "update_failed" }));
    expect(screen.getByText(/Could not update review items/)).toBeTruthy();
  });
});

// Static source scan: the route page + actions carry no forbidden literal / body column, no promotion target, no bare
// service-role literal, and no explicit fact-id form field.
describe("/connectors/review source — no leak, no promotion, no service-role", () => {
  const strip = (s: string) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  it("page.tsx + actions.ts reference no forbidden identifier", () => {
    const page = strip(fs.readFileSync(path.resolve(__dirname, "page.tsx"), "utf8"));
    const actions = strip(fs.readFileSync(path.resolve(__dirname, "actions.ts"), "utf8"));
    const svcRole = ["service", "role"].join("_");
    for (const src of [page, actions]) {
      for (const forbidden of ["discovery_facts", "fact_json", "natural_key", "signal_id", "source_record_id", "provenance_json", "connector_secret", "ciphertext", svcRole]) {
        expect(src).not.toContain(forbidden);
      }
      // NO promotion to managed records, and NO direct audit_logs insert.
      for (const forbidden of ["app_users", "identity_matches", "into public.people", "audit_logs"]) {
        expect(src).not.toContain(forbidden);
      }
    }
  });
});
