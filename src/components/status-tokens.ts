// Pure, dependency-free semantic status → tone map. NO React, NO DB, NO imports. Used by the shared Badge so
// every status column across the app shares one color language instead of hand-rolled monochrome pills.
export type StatusTone = "success" | "attention" | "danger" | "neutral";

const SUCCESS = new Set(["active", "succeeded", "uploaded", "confirmed", "matched"]);
const ATTENTION = new Set(["pending", "trial", "queued", "review"]);
const DANGER = new Set(["suspended", "expired", "failed", "error", "rejected", "revoked", "disabled"]);

// Case-insensitive. Unknown / inactive / archived / null / undefined / anything unmapped → "neutral". Never throws.
export function statusColor(value: string | null | undefined): StatusTone {
  if (value == null) return "neutral";
  const v = value.trim().toLowerCase();
  if (SUCCESS.has(v)) return "success";
  if (ATTENTION.has(v)) return "attention";
  if (DANGER.has(v)) return "danger";
  return "neutral";
}
