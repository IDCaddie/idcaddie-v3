// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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
vi.mock("@/lib/data/promotion-readiness", () => ({ getAppUserAccountPromotionReadiness: vi.fn() }));
vi.mock("./actions", () => ({ confirmReviewBatchAction: vi.fn(), rejectReviewBatchAction: vi.fn() }));

import SyncReviewPage from "./page";
import { resolveTenantContext } from "@/lib/auth/tenant-context";
import { getSyncReviewCounts, getSyncReviewPendingGroups } from "@/lib/data/sync-review";
import { getAppUserAccountPromotionReadiness } from "@/lib/data/promotion-readiness";

const asMock = <T,>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };
// Readiness has its own tests below; default it to the empty state so the OTHER tests render without caring about it.
const READINESS_ZERO = { ok: true, data: { total: 0, ready: 0, alreadyRepresented: 0, conflict: 0, missingRequired: 0, unsupported: 0 } };
beforeEach(() => asMock(getAppUserAccountPromotionReadiness).mockResolvedValue(READINESS_ZERO));
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

// Import readiness (docs/70 P1) — read-only count-only summary; identical for viewer + editor; no controls; fail-closed.
describe("/connectors/review — Import readiness (read-only counts)", () => {
  const READINESS = { ok: true, data: { total: 20, ready: 6, alreadyRepresented: 5, conflict: 4, missingRequired: 3, unsupported: 2 } };
  const LABELS = ["Total confirmed accounts", "Ready to add", "Already represented", "Conflicts", "Missing required data", "Unsupported"];
  const withReview = () => {
    asMock(getSyncReviewCounts).mockResolvedValue(COUNTS);
    asMock(getSyncReviewPendingGroups).mockResolvedValue({ ok: true, data: [GROUP] });
  };

  it("renders all six readiness buckets with counts, plus the read-only / not-imported explanation", async () => {
    setRole("editor"); withReview();
    asMock(getAppUserAccountPromotionReadiness).mockResolvedValue(READINESS);
    render(await render_());
    expect(screen.getByText("Import readiness")).toBeTruthy();
    for (const label of LABELS) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy(); // total (unique value)
    expect(screen.getByText(/no accounts have been imported/i)).toBeTruthy();
  });

  it("viewer and editor see the SAME count-only readiness summary (no controls in either)", async () => {
    for (const role of ["viewer", "editor"]) {
      setRole(role); withReview();
      asMock(getAppUserAccountPromotionReadiness).mockResolvedValue(READINESS);
      render(await render_());
      for (const label of LABELS) expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByText("20")).toBeTruthy();
      // NO control implying import/promotion exists (assert on control NAMES — the safe copy may say "promoted"/"import"
      // in prose, which is fine; what must not exist is an import/promote/execute button or link).
      expect(screen.queryByRole("button", { name: /import|promote|execute|add|dry.?run/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /import|promote|execute|add|dry.?run/i })).toBeNull();
      cleanup();
    }
  });

  it("total = 0 → empty state, and the six buckets are NOT shown", async () => {
    setRole("editor"); withReview();
    asMock(getAppUserAccountPromotionReadiness).mockResolvedValue(READINESS_ZERO);
    render(await render_());
    expect(screen.getByText("No confirmed accounts to assess yet.")).toBeTruthy();
    expect(screen.queryByText("Ready to add")).toBeNull();
    expect(screen.queryByText("Conflicts")).toBeNull();
  });

  it("DAL error → fail-closed unavailable state, leaking no value", async () => {
    setRole("editor"); withReview();
    asMock(getAppUserAccountPromotionReadiness).mockResolvedValue({ ok: false, error: "query_failed" });
    const { container } = render(await render_());
    expect(screen.getByText(/Import readiness is unavailable right now/)).toBeTruthy();
    expect(container.textContent).not.toContain("query_failed");
    expect(screen.queryByText("Ready to add")).toBeNull();
  });

  it("readiness UI adds NO buttons/forms/server-action path (editor, no pending batches)", async () => {
    setRole("editor");
    asMock(getSyncReviewCounts).mockResolvedValue({ ok: true, data: { ...COUNTS.data, pending: 0, total: 0, appUserAccounts: 0 } });
    asMock(getSyncReviewPendingGroups).mockResolvedValue({ ok: true, data: [] }); // no confirm/reject forms
    asMock(getAppUserAccountPromotionReadiness).mockResolvedValue(READINESS);
    const { container } = render(await render_());
    for (const label of LABELS) expect(screen.getByText(label)).toBeTruthy(); // readiness still rendered
    expect(screen.queryByRole("button")).toBeNull(); // ...with zero controls
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders no row-level identifiers or PII in the readiness summary", async () => {
    setRole("editor"); withReview();
    asMock(getAppUserAccountPromotionReadiness).mockResolvedValue(READINESS);
    const { container } = render(await render_());
    const txt = (container.textContent ?? "").toLowerCase();
    // structural body-field identifiers that would only appear if a row body leaked (the page's safety copy legitimately
    // mentions "tokens"/"secrets", so we assert on leak-field NAMES + an email shape, never the bare safety words).
    for (const forbidden of ["fact_json", "natural_key", "signal_id", "source_record_id", "provenance_json", "external_user_id", "@example.com"]) {
      expect(txt).not.toContain(forbidden);
    }
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
