import { describe, it, expect, vi, beforeEach } from "vitest";

// redirect() throws in Next; capture the target URL. revalidatePath is a no-op here.
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Mock ONLY the two write helpers; keep isReviewRejectReason (the fixed-enum gate) real.
const { confirmMock, rejectMock } = vi.hoisted(() => ({ confirmMock: vi.fn(), rejectMock: vi.fn() }));
vi.mock("@/lib/data/sync-review-actions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/sync-review-actions")>("@/lib/data/sync-review-actions");
  return { ...actual, confirmPendingReview: confirmMock, rejectPendingReview: rejectMock };
});

import { confirmReviewBatchAction, rejectReviewBatchAction } from "./actions";

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>): Promise<string | null> => {
  try { await p; return null; } catch (e) { return (e as Error).message; }
};

beforeEach(() => { confirmMock.mockReset(); rejectMock.mockReset(); });

describe("confirmReviewBatchAction — batch scope = run+type only", () => {
  it("calls confirmPendingReview with ONLY {sourceRunId, factType} (never fact ids) and redirects with the count", async () => {
    confirmMock.mockResolvedValue({ ok: true, data: { updated: 3 } });
    const msg = await redirectOf(confirmReviewBatchAction(fd({ sourceRunId: "run-1", factType: "app_user_account" })));
    expect(confirmMock).toHaveBeenCalledWith({ sourceRunId: "run-1", factType: "app_user_account" });
    expect(confirmMock.mock.calls[0][0]).not.toHaveProperty("factIds"); // no explicit fact ids
    expect(msg).toBe("REDIRECT:/connectors/review?status=confirmed_3");
  });

  it("missing run/type → no-op redirect, no helper call", async () => {
    const msg = await redirectOf(confirmReviewBatchAction(fd({ factType: "app_user_account" })));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(msg).toBe("REDIRECT:/connectors/review?status=noop");
  });

  it("helper failure → fail-closed error status", async () => {
    confirmMock.mockResolvedValue({ ok: false, error: "update_failed" });
    const msg = await redirectOf(confirmReviewBatchAction(fd({ sourceRunId: "run-1", factType: "app_user_account" })));
    expect(msg).toBe("REDIRECT:/connectors/review?status=update_failed");
  });

  it("zero-row no-op → confirmed_0 (page renders 'no changes')", async () => {
    confirmMock.mockResolvedValue({ ok: true, data: { updated: 0 } });
    const msg = await redirectOf(confirmReviewBatchAction(fd({ sourceRunId: "run-1", factType: "app_user_account" })));
    expect(msg).toBe("REDIRECT:/connectors/review?status=confirmed_0");
  });
});

describe("rejectReviewBatchAction — fixed reason enum only", () => {
  it("a valid fixed-enum reason calls rejectPendingReview({run,type}, reason) + rejected count", async () => {
    rejectMock.mockResolvedValue({ ok: true, data: { updated: 2 } });
    const msg = await redirectOf(rejectReviewBatchAction(fd({ sourceRunId: "run-1", factType: "app_user_account", reason: "duplicate" })));
    expect(rejectMock).toHaveBeenCalledWith({ sourceRunId: "run-1", factType: "app_user_account" }, "duplicate");
    expect(msg).toBe("REDIRECT:/connectors/review?status=rejected_2");
  });

  it("a reason outside the fixed enum fails closed (invalid_reason) with NO DB write", async () => {
    const msg = await redirectOf(rejectReviewBatchAction(fd({ sourceRunId: "run-1", factType: "app_user_account", reason: "free text leak@example.com" })));
    expect(rejectMock).not.toHaveBeenCalled();
    expect(msg).toBe("REDIRECT:/connectors/review?status=invalid_reason");
  });
});
