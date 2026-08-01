// Phase 15 Part 1 PR B — runtime validation of the migration-0061 product read RPC responses. The 0061 RPCs are absent from the
// generated database types (the repository narrow-casts the .rpc call), so every row/jsonb is parsed here BEFORE it reaches the graph
// engine or a view model. The zod object schemas are STRICT-by-default (zod strips unknown keys), which is the defense-in-depth that a
// prohibited column (external_id/raw_payload/…) can never reach the UI even if a future RPC change leaked one; a malformed sync_status or
// a missing id fails validation and the row is dropped rather than rendered. Pure module (no I/O); a window sentinel keeps it server-lean.

import { z } from "zod";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("access-rpc-types is server-only and must not be imported in client code");
}

const uuid = z.string().min(1);
const syncStatus = z.enum(["current", "stale", "review_required", "disconnected"]);
const nullableTs = z.string().nullable().optional().transform((v) => v ?? null);
const nullableText = z.string().nullable().optional().transform((v) => v ?? null);

// ── node rows (only SAFE columns; unknown keys are stripped by zod) ──────────────────────────────────────────────────────────────────
export const identityRowSchema = z.object({
  id: uuid, connection_id: uuid, provider: z.string().min(1), sync_status: syncStatus, stale_since: nullableTs,
  display_name: nullableText, login: nullableText, email: nullableText, is_active: z.boolean().nullable().optional().transform((v) => v ?? null), status: nullableText,
});
export const groupRowSchema = z.object({
  id: uuid, connection_id: uuid, provider: z.string().min(1), sync_status: syncStatus, stale_since: nullableTs,
  name: nullableText, group_type_category: nullableText,
});
export const applicationRowSchema = z.object({
  id: uuid, connection_id: uuid, provider: z.string().min(1), sync_status: syncStatus, stale_since: nullableTs,
  label: nullableText, name: nullableText, status_category: nullableText, sign_on_category: nullableText, catalog_match_status: nullableText,
});
// ── edge rows (canonical ROW-id references only; `id` is the edge's own row id — present in the LIST RPCs where it is the deterministic
// pagination cursor, absent in the SUBGRAPH RPCs which are single-call, so it is optional) ────────────────────────────────────────────
export const membershipRowSchema = z.object({
  id: uuid.optional(), connection_id: uuid, provider: z.string().min(1), directory_group_id: uuid, identity_account_id: uuid, sync_status: syncStatus, stale_since: nullableTs,
});
export const userAssignmentRowSchema = z.object({
  id: uuid.optional(), connection_id: uuid, provider: z.string().min(1), directory_application_id: uuid, identity_account_id: uuid, sync_status: syncStatus, stale_since: nullableTs,
});
export const groupAssignmentRowSchema = z.object({
  id: uuid.optional(), connection_id: uuid, provider: z.string().min(1), directory_application_id: uuid, directory_group_id: uuid, sync_status: syncStatus, stale_since: nullableTs,
});

// Phase 6 — the count contract is explicit about WHICH question it answers.
//
//   current       what the directory contains now — the customer-facing number
//   stale         retained but last seen in an earlier discovery
//   other         any other row state the CHECK permits (review_required, disconnected); nothing writes these today
//   totalEvidence every retained row — the conservative bound, and the ONLY count a safety gate may use
//
// Invariant: totalEvidence = current + stale + other. `other` is reported rather than folded into `stale`, so if something ever
// starts writing those states they appear honestly instead of inflating a category they do not belong to.
const resourceCounts = z.object({
  identities: z.number().int().nonnegative(), groups: z.number().int().nonnegative(), applications: z.number().int().nonnegative(),
  memberships: z.number().int().nonnegative(), userAssignments: z.number().int().nonnegative(), groupAssignments: z.number().int().nonnegative(),
});
export type ResourceCounts = z.infer<typeof resourceCounts>;

export const countsSchema = resourceCounts.extend({
  // The six flat keys above are DEPRECATED aliases of totalEvidence, retained so no existing caller changed meaning silently.
  // New code reads `current` or `totalEvidence` and says which it means.
  current: resourceCounts,
  stale: resourceCounts,
  other: resourceCounts,
  totalEvidence: resourceCounts,
});

// Phase 3 — the group subgraph. `bounded` is part of the contract, not an error: the RPC refuses to build the neighbourhood of a
// fan-in group (an "Everyone" that names every identity in the tenant) and says so, rather than truncating it into a list that
// looks complete. The summary is still returned in that case.
export const groupSubgraphSchema = z.object({
  group: groupRowSchema.extend({
    last_seen_at: nullableTs,
    description: nullableText,
    provider_created_at: nullableTs,
    provider_last_updated_at: nullableTs,
  }),
  bounded: z.boolean(),
  memberships: z.array(membershipRowSchema),
  identities: z.array(identityRowSchema),
  groupAssignments: z.array(groupAssignmentRowSchema),
  applications: z.array(applicationRowSchema),
  userAssignments: z.array(userAssignmentRowSchema),
});
export type GroupSubgraph = z.infer<typeof groupSubgraphSchema>;

export const identitySubgraphSchema = z.object({
  identity: identityRowSchema,
  memberships: z.array(membershipRowSchema), groups: z.array(groupRowSchema),
  userAssignments: z.array(userAssignmentRowSchema), groupAssignments: z.array(groupAssignmentRowSchema),
  applications: z.array(applicationRowSchema),
});
export const applicationSubgraphSchema = z.object({
  application: applicationRowSchema,
  userAssignments: z.array(userAssignmentRowSchema), groupAssignments: z.array(groupAssignmentRowSchema),
  groups: z.array(groupRowSchema), memberships: z.array(membershipRowSchema), identities: z.array(identityRowSchema),
});

export type IdentityRow = z.infer<typeof identityRowSchema>;
export type GroupRow = z.infer<typeof groupRowSchema>;
export type ApplicationRow = z.infer<typeof applicationRowSchema>;
export type MembershipRow = z.infer<typeof membershipRowSchema>;
export type UserAssignmentRow = z.infer<typeof userAssignmentRowSchema>;
export type GroupAssignmentRow = z.infer<typeof groupAssignmentRowSchema>;
export type Counts = z.infer<typeof countsSchema>;
export type IdentitySubgraph = z.infer<typeof identitySubgraphSchema>;
export type ApplicationSubgraph = z.infer<typeof applicationSubgraphSchema>;

// Parse an array of RPC rows, DROPPING any row that fails validation (malformed sync_status / missing id) rather than rendering it.
export function parseRows<T>(schema: z.ZodType<T>, rows: unknown): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const r of rows) { const p = schema.safeParse(r); if (p.success) out.push(p.data); }
  return out;
}
