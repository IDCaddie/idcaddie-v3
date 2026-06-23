// Server-only OKTA DISCOVERY FACT EMITTER — the FIRST real provider-data mapper (docs/42 §75). It transforms
// Okta-shaped application / user / app-assignment records into VALIDATED discovery facts and stages them through
// the EXISTING safe `discovery_facts` pipeline (PR #141 contract → PR #142 staging helper). It is NOT a live
// sync: it never fetches on its own — it maps records yielded by an INJECTED source (the real client is wired in
// a later PR; unit tests inject a mock), so there is NO live provider API call here.
//
// WHAT IT WRITES: ONLY validated discovery facts, ONLY through `stageDiscoveryFactsForReview` (the RLS-backed,
// user-scoped staging path). It NEVER writes the canonical app graph (apps / app_aliases / vendors /
// app_products), NEVER writes app_users / people / app_user_identity_matches, NEVER calls a provider in
// production, NEVER exchanges/stores tokens, NEVER reads/writes connector_secrets, and uses NO service-role
// client. It imports only the two sibling server-only modules below.
//
// SAFETY (fail closed):
//   * tenant_id ALWAYS comes from the authenticated `tenantId` argument — NEVER from the provider payload (the
//     payload's own tenant_id, if any, is simply never read). With no authenticated tenant, NOTHING is staged.
//   * ALLOWLIST CONSTRUCTION (not blocklist stripping): every fact is built from an EXPLICIT named allowlist of
//     safe Okta fields (app: id/label/name/signOnMode/status + explicit settings.app.url/domain scalars; user:
//     id/status/profile.email/profile.login; assignment: id/app id/status). The raw record is NEVER spread, and
//     app-level config landmines are NEVER read — not `settings` as a blob, not `settings.signOn` (signing keys),
//     not `_links`, `credentials`, `client_secret`, cookies, authorization headers, or any token. So an unexpected
//     or secret field on the source record cannot reach fact_json/provenance_json. Each built fact is additionally
//     re-validated via `parseDiscoveryFact` (the `.strict()` + provenance refine reject any token/secret key), and
//     the staging helper validates AGAIN.
//   * confidence is HIGH only because every fact is anchored on a DETERMINISTIC Okta object id (app id / user id)
//     — NOT on a name. No name-only canonical guess is emitted (no vendor_product mapping); canonical resolution
//     stays a later, reviewable step. A domain/instance_domain is set ONLY from an EXPLICIT Okta domain field,
//     never derived by parsing a URL.
//   * a malformed record (no stable id) is SKIPPED; one bad record never blocks the rest.
//
// SCHEMA-VOCABULARY NOTE: `source_type` uses the existing enum value `identity_provider_discovery` (Okta is an
// identity-provider discovery source) — the task's "provider/connector" maps onto this existing vocabulary; no
// new source_type is invented. There is NO dedicated `app_alias` fact type in the current schema, so alias
// signals are carried as `app_instance_identity` discriminators (external_instance_id = Okta app id =
// provider_app_id; instance_domain = explicit domain). A distinct `sso_app_id` alias has no schema field today —
// that is a documented gap for a later schema PR (docs/42 §75), NOT invented here.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.

import { parseDiscoveryFact, type DiscoveryFact } from "./discovery-facts";
import {
  stageDiscoveryFactsForReview,
  type DiscoveryFactStagingStore,
  type StageResult,
} from "./discovery-fact-staging";
import { normalizeEmail } from "./resolution"; // the EXISTING trim+lowercase normalizer — never a second definition

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/okta-discovery-emitter is server-only and must not be imported in client code");
}

const SOURCE_PROVIDER = "okta";
// Okta = identity-provider discovery — the existing SourceTypeSchema vocabulary (NOT a new "provider"/"connector").
const SOURCE_TYPE = "identity_provider_discovery";
const SCHEMA_VERSION = 1 as const;
// HIGH confidence is justified ONLY because every fact is anchored on a deterministic Okta object id.
const DETERMINISTIC_CONFIDENCE = 0.9;

// Server-provided context — `observedAt` (an ISO timestamp from the server, NOT generated here, so facts stay
// deterministic/stable) and an optional run id. tenant_id is a separate authenticated argument, never in here.
export type OktaEmitContext = { observedAt: string; sourceRunId?: string };

// The INJECTED Okta data source (the real client is wired later; tests inject a mock). The emitter never fetches
// directly, so a unit test makes NO live API call. Records are returned as untrusted plain objects.
export interface OktaDiscoverySource {
  listApplications(): Promise<readonly unknown[]>;
  listUsers(): Promise<readonly unknown[]>;
  listAppUsers(appId: string): Promise<readonly unknown[]>; // app assignments (the user↔app relationship)
}

export type OktaEmitSummary = {
  built: number;
  staged: number;
  rejected: number;
  results: StageResult[];
};

// ── defensive field access (provider data is untrusted) ─────────────────────────────────────────────────────
function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
// Build a provenance record of ONLY the present, safe scalar metadata (never a token/secret — those are never
// passed in). Returns undefined when empty so the optional field is simply omitted.
function provenance(
  entries: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(entries)) if (val != null) out[k] = val;
  return Object.keys(out).length > 0 ? out : undefined;
}
// Validate a built candidate against the discovery-fact contract; return it only if it is a clean, valid fact.
function validated(candidate: Record<string, unknown>): DiscoveryFact | null {
  const parsed = parseDiscoveryFact(candidate);
  return parsed.success ? parsed.data : null;
}
function base(signalId: string, tenantId: string, ctx: OktaEmitContext, sourceRecordId: string | null) {
  return {
    schema_version: SCHEMA_VERSION,
    signal_id: signalId,
    tenant_id: tenantId, // ALWAYS the authenticated tenant — never the provider payload
    source_type: SOURCE_TYPE,
    source_provider: SOURCE_PROVIDER,
    observed_at: ctx.observedAt,
    confidence: DETERMINISTIC_CONFIDENCE,
    ...(ctx.sourceRunId ? { source_run_id: ctx.sourceRunId } : {}),
    ...(sourceRecordId ? { source_record_id: sourceRecordId } : {}),
  };
}

// ── per-record transforms (pure; return ONLY validated facts; malformed → []) ───────────────────────────────

// An Okta application → an `app_discovery` fact (it exists, anchored on the Okta app id) + an
// `app_instance_identity` fact (external_instance_id = Okta app id = provider_app_id; instance_domain/url only
// when EXPLICIT). Malformed (no app id) → [].
export function oktaApplicationToFacts(app: unknown, tenantId: string, ctx: OktaEmitContext): DiscoveryFact[] {
  const r = asRecord(app);
  const appId = r && str(r.id);
  if (!r || !appId) return []; // no stable id → skip (fail closed)

  // ALLOWLIST: read ONLY these named, known-safe identity fields. We never spread the record, never read
  // `settings` as a blob, never read `settings.signOn` (signing keys), `_links`, `credentials`, or any
  // token/secret/cookie/authorization field — app-level Okta config is NOT assumed safe.
  const name = str(r.label) ?? str(r.name);
  const status = str(r.status);
  const signOnMode = str(r.signOnMode);
  // Domain/URL: ONLY the explicit, structured scalar fields `settings.app.url` / `settings.app.domain` are
  // pulled by exact name — never inferred from label/name/signOnMode/URL, never the whole settings object.
  const settingsApp = asRecord(asRecord(r.settings)?.app);
  const url = str(settingsApp?.url);
  const domain = str(settingsApp?.domain);
  const prov = provenance({ okta_app_status: status ?? undefined, okta_sign_on_mode: signOnMode ?? undefined });

  const facts: DiscoveryFact[] = [];
  // app_discovery requires a name; if the app has no label/name we still emit the instance-identity fact below.
  if (name) {
    const f = validated({
      ...base(`okta:app_discovery:${appId}`, tenantId, ctx, appId),
      fact_type: "app_discovery",
      discovered_app_name: name,
      source_app_id: appId,
      ...(domain ? { discovered_domain: domain } : {}),
      ...(url ? { source_app_url: url } : {}),
      ...(prov ? { provenance: prov } : {}),
    });
    if (f) facts.push(f);
  }
  // app_instance_identity — the alias/instance fact: external_instance_id is the deterministic Okta app id.
  const inst = validated({
    ...base(`okta:app_instance:${appId}`, tenantId, ctx, appId),
    fact_type: "app_instance_identity",
    external_instance_id: appId,
    ...(domain ? { instance_domain: domain } : {}),
    ...(url ? { instance_url: url } : {}),
    ...(prov ? { provenance: prov } : {}),
  });
  if (inst) facts.push(inst);
  return facts;
}

// An Okta user → an `app_user_account` fact (the Okta account, anchored on the user id) + a
// `person_identity_candidate` fact (the identity anchor) when a normalized email is available. Malformed → [].
export function oktaUserToFacts(user: unknown, tenantId: string, ctx: OktaEmitContext): DiscoveryFact[] {
  const r = asRecord(user);
  const userId = r && str(r.id);
  if (!r || !userId) return [];

  const profile = asRecord(r.profile);
  const email = normalizeEmail(str(profile?.email)) ?? normalizeEmail(str(profile?.login));
  const joined = [str(profile?.firstName), str(profile?.lastName)].filter(Boolean).join(" ").trim();
  const displayName = str(profile?.displayName) ?? (joined.length > 0 ? joined : null);
  const status = str(r.status);
  const prov = provenance({ okta_user_status: status ?? undefined });

  const facts: DiscoveryFact[] = [];
  const account = validated({
    ...base(`okta:app_user:${userId}`, tenantId, ctx, userId),
    fact_type: "app_user_account",
    app_user_external_id: userId,
    source_user_id: userId,
    ...(email ? { email } : {}),
    ...(displayName ? { display_name: displayName } : {}),
    ...(status ? { status } : {}),
    ...(prov ? { provenance: prov } : {}),
  });
  if (account) facts.push(account);

  if (email) {
    const person = validated({
      ...base(`okta:person:${userId}`, tenantId, ctx, userId),
      fact_type: "person_identity_candidate",
      primary_email: email,
      identity_provider_id: userId,
      ...(displayName ? { display_name: displayName } : {}),
      ...(prov ? { provenance: prov } : {}),
    });
    if (person) facts.push(person);
  }
  return facts;
}

// An Okta app assignment (application-user) → an `app_user_account` fact carrying the user↔app relationship
// (app_id_hint = the Okta app id). Malformed (no user id / no app id) → [].
export function oktaAssignmentToFacts(
  assignment: unknown,
  appId: string,
  tenantId: string,
  ctx: OktaEmitContext,
): DiscoveryFact[] {
  const r = asRecord(assignment);
  const userId = r && str(r.id); // Okta's app-user object id IS the user id
  const app = str(appId);
  if (!r || !userId || !app) return [];

  const profile = asRecord(r.profile);
  const email = normalizeEmail(str(profile?.email));
  const status = str(r.status);
  const prov = provenance({ okta_app_status: status ?? undefined, okta_scope: str(r.scope) ?? undefined });

  const fact = validated({
    ...base(`okta:assignment:${app}:${userId}`, tenantId, ctx, userId),
    fact_type: "app_user_account",
    app_user_external_id: userId,
    source_user_id: userId,
    app_id_hint: app,
    app_instance_key: app,
    ...(email ? { email } : {}),
    ...(status ? { status } : {}),
    ...(prov ? { provenance: prov } : {}),
  });
  return fact ? [fact] : [];
}

// ── orchestration: pull from the injected source → build validated facts → stage via the safe path ──────────

// Emit Okta discovery facts: build validated facts from the injected source's records and stage them through the
// authenticated, RLS-backed staging path. With no authenticated tenant, NOTHING is pulled or staged.
export async function emitOktaDiscoveryFacts(
  source: OktaDiscoverySource,
  store: DiscoveryFactStagingStore,
  tenantId: string | null | undefined,
  ctx: OktaEmitContext,
): Promise<OktaEmitSummary> {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    return { built: 0, staged: 0, rejected: 0, results: [] };
  }
  const facts: DiscoveryFact[] = [];
  for (const app of await source.listApplications()) {
    facts.push(...oktaApplicationToFacts(app, tenantId, ctx));
    const appId = asRecord(app) ? str(asRecord(app)!.id) : null;
    if (appId) {
      for (const assignment of await source.listAppUsers(appId)) {
        facts.push(...oktaAssignmentToFacts(assignment, appId, tenantId, ctx));
      }
    }
  }
  for (const user of await source.listUsers()) {
    facts.push(...oktaUserToFacts(user, tenantId, ctx));
  }

  const results = await stageDiscoveryFactsForReview(store, tenantId, facts);
  const staged = results.filter((r) => r.ok).length;
  return { built: facts.length, staged, rejected: results.length - staged, results };
}
