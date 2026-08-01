"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  uploadContractFileAction,
  getContractFileDownloadUrlAction,
} from "./file-actions";
import type { ContractFileSummary } from "@/lib/data/contract-files";

// Contract-file attachments UI (client). Handles file-input state + the loading/success/validation/
// failure states only — every authorization decision lives server-side (the server action → the
// user-scoped DAL → RLS + the storage.objects policies). The server page is the source of truth for
// the file list; after a successful upload we router.refresh() to re-fetch it. NO storage path,
// token, signed URL, or raw error is ever rendered — a download opens the signed URL via window.open
// without displaying it.

// Caller-safe labels for the validation reasons (no byte/path detail).
const REASON_LABEL: Record<string, string> = {
  empty_file: "The file is empty.",
  file_too_large: "The file is larger than 25 MB.",
  bad_extension: "Only PDF files are allowed.",
  bad_mime: "Only PDF files are allowed.",
  bad_magic: "That file does not look like a valid PDF.",
};

type Notice = { kind: "success" | "error"; msg: string } | null;

export function ContractFiles({
  contractId,
  files,
  listError,
}: {
  contractId: string;
  files: ContractFileSummary[];
  listError: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();

  function onUpload() {
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setNotice({ kind: "error", msg: "Choose a PDF first." });
      return;
    }
    const formData = new FormData();
    formData.set("file", file);
    setNotice(null);
    startTransition(async () => {
      const res = await uploadContractFileAction(contractId, formData);
      if (res.ok) {
        if (inputRef.current) inputRef.current.value = "";
        setNotice({ kind: "success", msg: "File uploaded." });
        router.refresh();
        return;
      }
      const msg =
        res.error === "invalid_file"
          ? REASON_LABEL[res.reason] ?? "That file could not be accepted."
          : res.error === "not_allowed"
            ? "You do not have permission to attach files to this contract."
            : res.error === "no_tenant"
              ? "No active tenant for your account."
              : res.error === "not_authenticated"
                ? "Your session has expired. Please sign in again."
                : res.error === "upload_failed"
                  ? "The upload did not complete. Please try again."
                  : "Something went wrong. Please try again.";
      setNotice({ kind: "error", msg });
    });
  }

  function onDownload(fileId: string) {
    setNotice(null);
    startTransition(async () => {
      const res = await getContractFileDownloadUrlAction(fileId);
      if (res.ok) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        setNotice({ kind: "error", msg: "Could not open this file right now." });
      }
    });
  }

  return (
    <section className="space-y-3 text-sm">
      <h2 className="font-medium">Files / Attachments</h2>
      <p className="text-xs text-zinc-500">
        Attach PDF contract documents (up to 25 MB). You only see documents for contracts you can access.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          disabled={pending}
          className="text-xs"
        />
        <button
          type="button"
          onClick={onUpload}
          disabled={pending}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
        >
          {pending ? "Working…" : "Upload PDF"}
        </button>
      </div>

      {notice ? (
        <p className={notice.kind === "success" ? "text-green-700 dark:text-green-500" : "text-red-600"}>
          {notice.msg}
        </p>
      ) : null}

      {listError ? (
        <p className="text-zinc-600 dark:text-zinc-400">Could not load files right now.</p>
      ) : files.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">No files attached yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {files.map((f) => {
            const finalized = f.uploadStatus === "uploaded";
            const statusLabel = finalized
              ? "Uploaded"
              : f.uploadStatus === "failed"
                ? "Upload failed — not openable"
                : "Pending — not yet openable";
            return (
              <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{f.filename}</span>
                  <span className="block text-xs text-zinc-500">
                    {f.createdAt.slice(0, 10)} · {statusLabel}
                  </span>
                </span>
                {finalized ? (
                  <button
                    type="button"
                    onClick={() => onDownload(f.id)}
                    disabled={pending}
                    className="shrink-0 rounded border border-zinc-300 px-2.5 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
                  >
                    Open
                  </button>
                ) : (
                  // Open is shown ONLY for a finalized upload (confirmed Storage object). A pending/
                  // failed row may have no object, so it is not openable.
                  <span className="shrink-0 text-xs text-zinc-400">—</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
