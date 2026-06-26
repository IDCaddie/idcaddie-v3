// Server-only SLACK DISCOVERY-FACT EMITTER (Slack P0 PR 3). Maps the live-verified, NORMALIZED Slack records from the
// PR #188 client (auth.test workspace identity + SlackUserRecord[]) into VALIDATED v3 discovery facts.
//
// SCOPE: this PR proves  normalized Slack records → fact candidates → parseDiscoveryFact → safe fact array.  It STOPS
// there. It does NOT stage to the DB, does NOT call the resolver, does NOT call Slack (the records are INJECTED), does
// NOT build UI / a manual trigger / OAuth / the runner / KMS. It imports ONLY the discovery-fact contract + the existing
// email normalizer + the Slack record TYPES (type-only).
//
// SAFETY (mirrors okta-discovery-emitter.ts):
//   * tenant_id ALWAYS from the authenticated `tenantId` argument — NEVER from any record payload (records carry no
//     tenant_id, and a payload field with that name is simply never read). No tenant → nothing emitted.
//   * observed_at is passed IN from the caller (ctx.observedAt) — never generated here, so facts stay deterministic.
//   * ALLOWLIST construction (never a raw spread): each candidate is built from explicit, named, known-safe normalized
//     fields. has_2fa / has_sso are NEVER read (live-verified unavailable via P0 users.list). Every candidate is then
//     re-validated via `parseDiscoveryFact` (strict schema + provenance refine reject any token/secret key).
//   * deterministic signal ids only (Slack team id / user id / normalized email) — no random ids, no timestamps in ids.
//   * a malformed record (no id) or a bot record is SKIPPED; one bad record never blocks the rest of the batch.
//
// SCHEMA-VOCABULARY NOTE: `source_type` uses the existing enum value `deep_provider_sync` (Slack is a SaaS provider
// sync, not an identity provider) — no new source_type is invented.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { parseDiscoveryFact, type DiscoveryFact } from "./discovery-facts";
import { normalizeEmail } from "./resolution"; // the EXISTING trim+lowercase normalizer — never a second definition
import type { SlackAuthTestResult, SlackUserRecord } from "../sync/slack/slack-client"; // type-only — no runtime coupling

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/slack-discovery-emitter is server-only and must not be imported in client code");
}

const SOURCE_PROVIDER = "slack";
const SOURCE_TYPE = "deep_provider_sync"; // existing SourceTypeSchema vocabulary (a provider sync, not an IdP)
const SCHEMA_VERSION = 1 as const;
const DETERMINISTIC_CONFIDENCE = 0.9; // anchored on deterministic Slack ids / normalized email
const ACTIVITY_CONFIDENCE = 0.5; // a Slack profile-`updated` ts is a WEAK activity proxy — lower confidence

// Server-provided context — `observedAt` (ISO, from the server) + optional run id. tenant_id is a separate arg.
export type SlackEmitContext = { observedAt: string; sourceRunId?: string };
export type SlackEmitInput = { workspace: SlackAuthTestResult; users: readonly SlackUserRecord[] };
export type SlackEmitSummary = { facts: DiscoveryFact[]; built: number; rejected: number };

// ── defensive field access (records are treated as untrusted) ───────────────────────────────────────────────
function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function provenance(entries: Record<string, string | number | boolean | null | undefined>): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(entries)) if (val != null) out[k] = val;
  return Object.keys(out).length > 0 ? out : undefined;
}
function toIso(epochSeconds: unknown): string | null {
  // FAIL CLOSED on out-of-range epochs — `updated` is untrusted and unbounded; > 8.64e15 ms is past JS's max Date and
  // would make `.toISOString()` THROW (RangeError). Return null instead of throwing so one bad ts can't crash the batch.
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds) || epochSeconds <= 0 || epochSeconds * 1000 > 8.64e15) return null;
  return new Date(epochSeconds * 1000).toISOString();
}
function validated(candidate: Record<string, unknown>): DiscoveryFact | null {
  const parsed = parseDiscoveryFact(candidate);
  return parsed.success ? parsed.data : null;
}
function base(signalId: string, tenantId: string, ctx: SlackEmitContext, sourceRecordId: string | null, confidence = DETERMINISTIC_CONFIDENCE) {
  return {
    schema_version: SCHEMA_VERSION,
    signal_id: signalId,
    tenant_id: tenantId, // ALWAYS the authenticated tenant — never a record payload
    source_type: SOURCE_TYPE,
    source_provider: SOURCE_PROVIDER,
    observed_at: ctx.observedAt,
    confidence,
    ...(ctx.sourceRunId ? { source_run_id: ctx.sourceRunId } : {}),
    ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
  };
}

// ── per-record candidate construction (allowlist; pure; returns Record candidates, NOT yet validated) ─────────

// The workspace → an `app_discovery` fact (Slack exists; once per sync) + an `app_instance_identity` fact anchored on
// the Slack team id. Malformed (no team id) → [].
export function slackWorkspaceCandidates(workspace: unknown, tenantId: string, ctx: SlackEmitContext): Record<string, unknown>[] {
  const w = asRecord(workspace);
  const teamId = w && str(w.teamId);
  if (!w || !teamId) return [];
  const teamName = str(w.teamName);
  const url = str(w.url);
  const out: Record<string, unknown>[] = [
    {
      ...base("slack:app_discovery:slack", tenantId, ctx, teamId),
      fact_type: "app_discovery",
      discovered_app_name: "Slack",
      discovered_vendor_name: "Slack",
      category: "Communication",
    },
    {
      ...base(`slack:app_instance:${teamId}`, tenantId, ctx, teamId),
      fact_type: "app_instance_identity",
      external_instance_id: teamId,
      workspace_id: teamId,
      ...(url ? { instance_url: url } : {}),
      ...(provenance({ slack_team_name: teamName ?? undefined }) ? { provenance: provenance({ slack_team_name: teamName ?? undefined }) } : {}),
    },
  ];
  return out;
}

// One NON-BOT user record → app_user_account (always) + person_identity_candidate (only with email) + role_admin (only
// for admin/owner/primary_owner) + usage_activity (only with a real last-activity ts). Malformed/bot → [].
export function slackUserCandidates(user: unknown, workspaceTeamId: string, tenantId: string, ctx: SlackEmitContext): Record<string, unknown>[] {
  const r = asRecord(user);
  const userId = r && str(r.slackUserId);
  if (!r || !userId) return []; // no stable id → skip (fail closed)
  if (r.isBot === true || userId === "USLACKBOT") return []; // defensive bot filter (P0)

  const teamId = str(r.teamId) ?? str(workspaceTeamId); // the workspace anchor; record team must match the single workspace
  if (!teamId) return [];
  const email = normalizeEmail(str(r.email)); // lower-cased + trimmed; null when absent
  const displayName = str(r.displayName); // PR #188 already prefers display_name → real_name fallback
  const status = str(r.status);
  const roleHint = str(r.roleHint) ?? "member";
  const isAdmin = r.isAdmin === true;
  const isOwner = r.isOwner === true;
  const isPrimaryOwner = r.isPrimaryOwner === true;
  const lastActivityIso = toIso(r.lastActivityAt);
  const prov = provenance({
    slack_role_hint: roleHint,
    slack_title: str(r.title) ?? undefined,
    slack_timezone: str(r.timezone) ?? undefined,
    slack_is_restricted: r.isRestricted === true ? true : undefined,
    slack_is_ultra_restricted: r.isUltraRestricted === true ? true : undefined,
    slack_is_deleted: r.isDeleted === true ? true : undefined,
  });
  const anchor = `${teamId}:${userId}`;
  const out: Record<string, unknown>[] = [];

  // C. app_user_account — ALWAYS (even without email).
  out.push({
    ...base(`slack:app_user:${anchor}`, tenantId, ctx, userId),
    fact_type: "app_user_account",
    app_user_external_id: userId,
    source_user_id: userId,
    app_id_hint: "slack",
    app_instance_key: teamId,
    role_hint: roleHint,
    ...(email ? { email } : {}),
    ...(displayName ? { display_name: displayName } : {}),
    ...(status ? { status } : {}),
    ...(lastActivityIso ? { last_activity_at: lastActivityIso } : {}),
    ...(prov ? { provenance: prov } : {}),
  });

  // D. person_identity_candidate — ONLY when email exists (skip construction entirely otherwise).
  if (email) {
    out.push({
      ...base(`slack:person:${email}`, tenantId, ctx, userId), // signal id keyed on the NORMALIZED lower-cased email
      fact_type: "person_identity_candidate",
      primary_email: email,
      identity_provider_id: anchor,
      ...(displayName ? { display_name: displayName } : {}),
    });
  }

  // E. role_admin — ONLY for admin/owner/primary_owner; priority primary_owner > owner > admin. Plain members → none.
  if (isAdmin || isOwner || isPrimaryOwner) {
    const roleName = isPrimaryOwner ? "primary_owner" : isOwner ? "owner" : "admin";
    out.push({
      ...base(`slack:role_admin:${anchor}`, tenantId, ctx, userId),
      fact_type: "role_admin",
      role_name: roleName,
      is_admin: true,
      role_scope: teamId,
    });
  }

  // F. usage_activity — ONLY when a real last-activity ts exists (Slack `updated`); omit entirely when unknown.
  if (lastActivityIso) {
    out.push({
      ...base(`slack:usage:${anchor}`, tenantId, ctx, userId, ACTIVITY_CONFIDENCE),
      fact_type: "usage_activity",
      last_activity_at: lastActivityIso,
      usage_source: "slack_users_list_updated", // honest: derived from the profile `updated` ts, a weak activity proxy
      usage_confidence: ACTIVITY_CONFIDENCE,
    });
  }

  return out;
}

// ── orchestration: normalized records → validated facts (NO DB, NO resolver, NO Slack call) ──────────────────
export function emitSlackDiscoveryFacts(input: SlackEmitInput, tenantId: string, ctx: SlackEmitContext): SlackEmitSummary {
  if (!str(tenantId) || !ctx || !str(ctx.observedAt)) return { facts: [], built: 0, rejected: 0 }; // fail closed
  const workspace = asRecord(input?.workspace);
  const teamId = workspace && str(workspace.teamId);
  if (!teamId) return { facts: [], built: 0, rejected: 0 }; // no workspace anchor → nothing emitted

  const users = Array.isArray(input.users) ? input.users : [];
  const candidates: Record<string, unknown>[] = [];
  let rejected = 0;
  // Defense in depth: a per-record CONSTRUCTION throw (any future surprise on untrusted data) increments `rejected`
  // (safe count only) — it never escapes to fail the whole batch.
  const collect = (fn: () => Record<string, unknown>[]) => {
    try { candidates.push(...fn()); } catch { rejected++; }
  };
  collect(() => slackWorkspaceCandidates(input.workspace, tenantId, ctx));
  for (const u of users) collect(() => slackUserCandidates(u, teamId, tenantId, ctx));

  const facts: DiscoveryFact[] = [];
  for (const c of candidates) {
    const v = validated(c); // re-validated against the strict contract — invalid dropped, never throws
    if (v) facts.push(v);
    else rejected++; // safe count only — the raw candidate is NEVER logged
  }
  return { facts, built: candidates.length, rejected };
}
