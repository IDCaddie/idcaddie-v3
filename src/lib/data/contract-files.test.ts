import { describe, it, expect, vi, beforeEach } from "vitest";

// App-layer wiring tests for the contract-file DAL. The DB-level cross-tenant denial (files SELECT/
// INSERT RLS, cross-tenant attach FK, uploaded_by spoof) is already proven by org_rls_test.sql T34 +
// the hosted Storage REST verifier 14/14 — these tests cover what THIS module adds: server-derived
// tenant + path, files-row-FIRST ordering, validate-before-DB, error classification, signed-URL only
// after the RLS read, and that no storage path / signed URL leaks into the list DTO.

const createClient = vi.fn();
const resolveTenantContext = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("@/lib/auth/tenant-context", () => ({ resolveTenantContext: () => resolveTenantContext() }));

import {
  uploadContractFileForCurrentUser,
  getContractFileDownloadUrlForCurrentUser,
  listContractFilesForCurrentUser,
} from "./contract-files";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "0a000000-0000-0000-0000-000000000001";
const CONTRACT = "c0000000-0000-0000-0000-0000000000a1";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const NOT_PDF = new Uint8Array([0x68, 0x69, 0x21]); // "hi!"

type SupaCfg = {
  insertError?: { code?: string } | null;
  uploadError?: unknown;
  updateError?: unknown;
  listData?: unknown[];
  listError?: unknown;
  downloadData?: { storage_path: string; upload_status?: string } | null;
  downloadError?: unknown;
  signed?: { signedUrl: string } | null;
  signError?: unknown;
};

// Captures the calls we assert on.
let captured: {
  insert?: Record<string, unknown>;
  updates: Record<string, unknown>[];
  uploadArgs?: unknown[];
  signArgs?: unknown[];
};

function makeSupabase(cfg: SupaCfg) {
  captured = { updates: [] };
  const from = () => ({
    insert: (payload: Record<string, unknown>) => {
      captured.insert = payload;
      return Promise.resolve({ error: cfg.insertError ?? null });
    },
    update: (payload: Record<string, unknown>) => ({
      eq: () => {
        captured.updates.push(payload);
        return Promise.resolve({ error: cfg.updateError ?? null });
      },
    }),
    select: () => ({
      eq: () => ({
        order: () => Promise.resolve({ data: cfg.listData ?? [], error: cfg.listError ?? null }),
        maybeSingle: () =>
          Promise.resolve({ data: cfg.downloadData ?? null, error: cfg.downloadError ?? null }),
      }),
    }),
  });
  const storage = {
    from: () => ({
      upload: (...args: unknown[]) => {
        captured.uploadArgs = args;
        return Promise.resolve({ error: cfg.uploadError ?? null });
      },
      createSignedUrl: (...args: unknown[]) => {
        captured.signArgs = args;
        return Promise.resolve({ data: cfg.signed ?? null, error: cfg.signError ?? null });
      },
    }),
  };
  return { from, storage };
}

function setContext(ctx: unknown) {
  resolveTenantContext.mockResolvedValue(ctx);
}
const goodContext = { status: "resolved", userId: USER, activeTenant: { id: TENANT }, organizationMemberships: [] };

beforeEach(() => {
  createClient.mockReset();
  resolveTenantContext.mockReset();
});

describe("uploadContractFileForCurrentUser", () => {
  it("rejects a non-PDF before any DB/context call", async () => {
    const res = await uploadContractFileForCurrentUser({
      contractId: CONTRACT,
      originalFilename: "x.pdf",
      contentType: "application/pdf",
      bytes: NOT_PDF,
    });
    expect(res).toEqual({ ok: false, error: "invalid_file", reason: "bad_magic" });
    expect(resolveTenantContext).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID contractId as not_allowed", async () => {
    const res = await uploadContractFileForCurrentUser({
      contractId: "not-a-uuid",
      originalFilename: "x.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    expect(res).toEqual({ ok: false, error: "not_allowed" });
  });

  it("returns not_authenticated when there is no context", async () => {
    setContext(null);
    const res = await uploadContractFileForCurrentUser({
      contractId: CONTRACT,
      originalFilename: "x.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    expect(res).toEqual({ ok: false, error: "not_authenticated" });
  });

  it("happy path: server-derived tenant + path, files-row-first, then upload", async () => {
    setContext(goodContext);
    createClient.mockResolvedValue(makeSupabase({}));
    const res = await uploadContractFileForCurrentUser({
      contractId: CONTRACT,
      originalFilename: "../evil/My Contract.pdf", // path components stripped to a display label
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    expect(res.ok).toBe(true);
    const ins = captured.insert!;
    // tenant_id is the SERVER-resolved tenant (never from the caller) and uploaded_by is the caller.
    expect(ins.tenant_id).toBe(TENANT);
    expect(ins.uploaded_by).toBe(USER);
    expect(ins.contract_id).toBe(CONTRACT);
    expect(ins.content_type).toBe("application/pdf");
    expect(ins.upload_status).toBe("pending");
    expect(ins.original_filename).toBe("My Contract.pdf"); // sanitized display name, no path
    // path is server-derived contracts/{tenant}/{file_id}.pdf and the row id IS that file_id.
    expect(ins.storage_path).toBe(`contracts/${TENANT}/${ins.id}.pdf`);
    expect(ins.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ins.upload_status).toBe("pending"); // inserted pending, finalized below
    // upload happened AFTER the insert, to the SAME server-derived path.
    expect(captured.uploadArgs?.[0]).toBe(ins.storage_path);
    // FINALIZE: a successful upload flips the row to 'uploaded' (no ambiguous pending row).
    expect(captured.updates).toContainEqual({ upload_status: "uploaded" });
  });

  it("RLS-denied metadata insert → not_allowed, no object upload, no finalize", async () => {
    setContext(goodContext);
    createClient.mockResolvedValue(makeSupabase({ insertError: { code: "42501" } }));
    const res = await uploadContractFileForCurrentUser({
      contractId: CONTRACT,
      originalFilename: "x.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    expect(res).toEqual({ ok: false, error: "not_allowed" });
    expect(captured.uploadArgs).toBeUndefined(); // row-first failed → never uploaded bytes
    expect(captured.updates).toEqual([]); // never finalized
  });

  it("object upload failure → upload_failed AND the row is dispositioned 'failed' (not ambiguous pending)", async () => {
    setContext(goodContext);
    createClient.mockResolvedValue(makeSupabase({ uploadError: { message: "boom" } }));
    const res = await uploadContractFileForCurrentUser({
      contractId: CONTRACT,
      originalFilename: "x.pdf",
      contentType: "application/pdf",
      bytes: PDF_BYTES,
    });
    expect(res).toEqual({ ok: false, error: "upload_failed" });
    expect(captured.updates).toContainEqual({ upload_status: "failed" });
    expect(captured.updates).not.toContainEqual({ upload_status: "uploaded" });
  });
});

describe("getContractFileDownloadUrlForCurrentUser", () => {
  it("RLS-hidden / missing row → not_found, never signs", async () => {
    createClient.mockResolvedValue(makeSupabase({ downloadData: null }));
    const res = await getContractFileDownloadUrlForCurrentUser("13000000-0000-0000-0000-0000000000f1");
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(captured.signArgs).toBeUndefined();
  });

  it("non-finalized (pending) row → not_ready, never signs", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        downloadData: { storage_path: `contracts/${TENANT}/abc.pdf`, upload_status: "pending" },
        signed: { signedUrl: "https://example.test/signed" },
      }),
    );
    const res = await getContractFileDownloadUrlForCurrentUser("13000000-0000-0000-0000-0000000000f1");
    expect(res).toEqual({ ok: false, error: "not_ready" });
    expect(captured.signArgs).toBeUndefined();
  });

  it("finalized (uploaded) row → short-lived signed URL", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        downloadData: { storage_path: `contracts/${TENANT}/abc.pdf`, upload_status: "uploaded" },
        signed: { signedUrl: "https://example.test/signed" },
      }),
    );
    const res = await getContractFileDownloadUrlForCurrentUser("13000000-0000-0000-0000-0000000000f1");
    expect(res).toEqual({ ok: true, url: "https://example.test/signed" });
    expect(captured.signArgs?.[0]).toBe(`contracts/${TENANT}/abc.pdf`);
    expect(captured.signArgs?.[1]).toBe(60); // short-lived
  });
});

describe("listContractFilesForCurrentUser", () => {
  it("maps rows to a DTO that never exposes storage_path", async () => {
    createClient.mockResolvedValue(
      makeSupabase({
        listData: [
          {
            id: "13000000-0000-0000-0000-0000000000f1",
            original_filename: "a.pdf",
            upload_status: "uploaded",
            created_at: "2026-06-19T00:00:00Z",
            storage_path: "contracts/secret/path.pdf", // present in the row, must NOT survive into the DTO
          },
        ],
      }),
    );
    const res = await listContractFilesForCurrentUser(CONTRACT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data[0]).toEqual({
        id: "13000000-0000-0000-0000-0000000000f1",
        filename: "a.pdf",
        uploadStatus: "uploaded",
        createdAt: "2026-06-19T00:00:00Z",
      });
      expect("storage_path" in res.data[0]).toBe(false);
    }
  });
});
