// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The three list states must stay visually distinct. The bug this file pins: an org-scoped contract
// reader cannot read ANY `files` row (0013 SELECT is tenant-member-only, narrower than the 0003
// contract read union), so their empty read was rendered as "No files attached yet" — the product
// claiming a contract has no documents when it simply could not look.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./file-actions", () => ({
  uploadContractFileAction: vi.fn(),
  getContractFileDownloadUrlAction: vi.fn(),
}));

import { ContractFiles } from "./contract-files";

const CONTRACT = "c0000000-0000-0000-0000-0000000000a1";
const FILE_ID = "13000000-0000-0000-0000-0000000000f1";
const ROW = { id: FILE_ID, filename: "MSA.pdf", uploadStatus: "uploaded", createdAt: "2026-06-19T00:00:00Z" };

const NO_DOCUMENTS_CLAIM = /No files attached yet/i;

afterEach(cleanup);

describe("ContractFiles list states", () => {
  it("(1) TRUE EMPTY — readable and genuinely zero files → the honest empty claim", () => {
    render(<ContractFiles contractId={CONTRACT} files={[]} listState="ok" />);
    expect(screen.getByText(NO_DOCUMENTS_CLAIM)).toBeTruthy();
  });

  it("(2) READABLE — rows render, and the empty claim is absent", () => {
    const { container } = render(<ContractFiles contractId={CONTRACT} files={[ROW]} listState="ok" />);
    expect(screen.getByText("MSA.pdf")).toBeTruthy();
    expect(container.textContent).not.toMatch(NO_DOCUMENTS_CLAIM);
  });

  it("(3) DENIED — not_readable NEVER claims the contract has no documents", () => {
    const { container } = render(<ContractFiles contractId={CONTRACT} files={[]} listState="not_readable" />);
    expect(container.textContent).not.toMatch(NO_DOCUMENTS_CLAIM);
    expect(container.textContent).not.toMatch(/No documents/i);
    // It says why, in bounded copy, without naming a policy, table or id.
    expect(screen.getByText(/does not include its documents/i)).toBeTruthy();
  });

  it("(4) ERROR — a failed read NEVER claims the contract has no documents, and is distinct from denied", () => {
    const { container } = render(<ContractFiles contractId={CONTRACT} files={[]} listState="error" />);
    expect(container.textContent).not.toMatch(NO_DOCUMENTS_CLAIM);
    expect(screen.getByText(/Could not load files right now/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/does not include its documents/i);
  });

  it("(5) no id, storage path, table or policy name leaks in any state", () => {
    for (const listState of ["ok", "error", "not_readable"] as const) {
      const { container, unmount } = render(
        <ContractFiles contractId={CONTRACT} files={listState === "ok" ? [ROW] : []} listState={listState} />,
      );
      const text = container.textContent ?? "";
      for (const forbidden of [CONTRACT, FILE_ID, "storage_path", "contracts/", "tenant_id", "RLS", "0013", "row-level"]) {
        expect(text).not.toContain(forbidden);
      }
      unmount();
    }
  });

  it("(6) the three states are mutually exclusive — exactly one message per state", () => {
    const messages = [NO_DOCUMENTS_CLAIM, /does not include its documents/i, /Could not load files right now/i];
    for (const listState of ["ok", "error", "not_readable"] as const) {
      const { container, unmount } = render(<ContractFiles contractId={CONTRACT} files={[]} listState={listState} />);
      const hits = messages.filter((m) => m.test(container.textContent ?? "")).length;
      expect(hits).toBe(1);
      unmount();
    }
  });

  it("(7) authorized happy path unchanged — the upload control still renders in every state", () => {
    for (const listState of ["ok", "error", "not_readable"] as const) {
      const { unmount } = render(<ContractFiles contractId={CONTRACT} files={[]} listState={listState} />);
      // Write authority is governed server-side (can_write_contract) and is NOT changed by this fix:
      // an org procurement-manager may still attach a file even where they cannot list files.
      expect(screen.getByText(/Upload/i)).toBeTruthy();
      unmount();
    }
  });
});
