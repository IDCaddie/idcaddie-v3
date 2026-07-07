// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ExportCsvButton } from "./export-csv-button";

// jsdom's Blob has no .text(); capture the content passed to the Blob constructor + stub the URL helpers it lacks.
let csvContent: string | null = null;
let blobType: string | null = null;
beforeEach(() => {
  csvContent = null;
  blobType = null;
  const OrigBlob = globalThis.Blob;
  vi.stubGlobal(
    "Blob",
    class extends OrigBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        csvContent = String(parts[0]);
        blobType = options?.type ?? null;
      }
    },
  );
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("apps ExportCsvButton", () => {
  it("renders and, on click, builds a text/csv download from exactly the safe strings it was given", () => {
    render(<ExportCsvButton headers={["Name", "Owner assigned"]} rows={[["Figma", "No"], ["Slack", "Yes"]]} filename="apps-export.csv" />);
    const btn = screen.getByRole("button", { name: "Export CSV" });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect((URL as unknown as { createObjectURL: { mock: { calls: unknown[] } } }).createObjectURL.mock.calls.length).toBe(1);
    expect(blobType).toContain("text/csv");
    expect(csvContent).toBe("Name,Owner assigned\r\nFigma,No\r\nSlack,Yes");
  });
});
