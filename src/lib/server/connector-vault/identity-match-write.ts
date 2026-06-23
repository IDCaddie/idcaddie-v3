// Server-only DETERMINISTIC APP_USER → PERSON IDENTITY-MATCH WRITE PATH — the first canonical USER-identity
// write (docs/42 §72). It connects an app_user to a person ONLY on DETERMINISTIC, tenant-safe evidence, so
// canonical user rollups can count DISTINCT people instead of raw app accounts. This is NOT provider sync, NOT
// probabilistic matching, NOT human-review promotion.
//
// DETERMINISTIC EVIDENCE ONLY (fail closed otherwise):
//   * an EXACT normalized email match (app_user.email == person.primary_email, or == identity_accounts.email
//     that is already tied to a person);
//   * an EXACT provider external-user-id match (identity_accounts (provider, external_id) tied to a person),
//     where tenant + provider align.
// NEVER on display-name / first-last-name similarity, email-domain-only, vendor/app membership alone, account
// status alone, a low-confidence fact alone, or any cross-tenant evidence. If MULTIPLE candidate people share
// the signal → review / no write. If a match already exists to a DIFFERENT person → no overwrite (review). A
// false person-merge is more expensive than leaving an app_user unmatched.
//
// IDEMPOTENT + ONE-PERSON-PER-APP_USER: the write upserts on the natural key (tenant_id, app_user_id)
// (UNIQUE from 0028) — re-running the same candidate set adds NO app_user_identity_matches rows, and the DB
// itself REJECTS a second match for the same app_user to a DIFFERENT person (a false double-match), not just
// the helper's in-code conflict check. (The 0001 UNIQUE(app_user_id, person_id) is kept, but (tenant_id,
// app_user_id) is the constraint that backs the write/idempotency invariant.) Tenant scoping comes from the
// authenticated tenantId + RLS (the write functions do NOTHING without an authenticated tenant).
//
// NON-DESTRUCTIVE CORRECTION: `repointIdentityMatch` UPDATEs a match's person_id to the correct person — it
// NEVER deletes the match, the app_user, the person, identity_accounts, apps, contracts, invoices, or audit
// history. `app_user_identity_matches` has NO DELETE policy (the 0004 directive, kept by 0027), so a wrong
// match is repointed, never erased. (A soft "unmatched" status would need a future status column — NOT invented
// here; this PR stays minimal.)
//
// SAFE BY DESIGN: the only DB access is through the INJECTED `IdentityMatchWriteStore`, backed by the
// authenticated user-scoped (RLS) client when wired — this module imports NO Supabase client and uses NO
// service-role. It writes ONLY `app_user_identity_matches` — never an app graph / app_alias / vendor / product
// row — calls NO provider, and touches NO token/credential/connector_secrets.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts`.
// It has NO imports (pure TS logic + an injected store).

// Runtime server-only sentinel — throw if evaluated in a browser.
if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/identity-match-write is server-only and must not be imported in client code");
}

// The deterministic match method written to app_user_identity_matches.match_method — this distinguishes a
// deterministic AUTO match (reviewed_by null) from a future human-confirmed match (a different match_method +
// reviewed_by set).
export type DeterministicMatchMethod =
  | "auto_exact_email"
  | "auto_identity_account_email"
  | "auto_external_id";

// An app_user candidate to (maybe) match — the deterministic signals it carries.
export type AppUserMatchCandidate = {
  appUserId: string;
  tenantId: string;
  email?: string | null;
  provider?: string | null;
  externalUserId?: string | null;
};

export type IdentityMatchOutcome = "matched" | "review";

export type IdentityMatchResult = {
  appUserId: string;
  outcome: IdentityMatchOutcome;
  reason: string;
  personId?: string;
  matchMethod?: DeterministicMatchMethod;
};

// The injected WRITE/READ boundary, backed by the authenticated user-scoped (RLS) client when wired — never a
// service-role client. Every lookup returns ONLY the current tenant's rows (RLS). The lookups return ARRAYS so
// the helper can fail closed when more than one candidate person shares a signal. There is NO delete method.
export interface IdentityMatchWriteStore {
  // distinct person ids whose primary_email == the normalized email (current tenant).
  findPersonIdsByPrimaryEmail(normalizedEmail: string): Promise<readonly string[]>;
  // distinct person ids reachable via an identity_account whose email == the normalized email AND person_id set.
  findPersonIdsByIdentityAccountEmail(normalizedEmail: string): Promise<readonly string[]>;
  // distinct person ids reachable via an identity_account (provider, external_id) tied to a person.
  findPersonIdsByExternalId(input: { provider: string; externalId: string }): Promise<readonly string[]>;
  // the person this app_user is ALREADY matched to (any method), or null — used to detect a conflict.
  getExistingMatchPersonId(appUserId: string): Promise<string | null>;
  // upsert a match on the natural key (tenant_id, app_user_id) — ON CONFLICT (tenant_id, app_user_id) DO
  // NOTHING (UNIQUE from 0028). Returns whether a NEW row was created. The DB rejects a second app_user → a
  // different person; this method is only reached after the helper's conflict check, so it is a same-row no-op.
  upsertMatch(input: { appUserId: string; personId: string; matchMethod: DeterministicMatchMethod }): Promise<{ created: boolean }>;
  // non-destructive correction: repoint an existing match to a different person (UPDATE person_id). No delete.
  repointMatch(input: { appUserId: string; fromPersonId: string; toPersonId: string }): Promise<void>;
}

// Normalize an email for deterministic comparison (trim + lowercase). Returns null for blank / non-emails.
function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.length > 0 && e.includes("@") ? e : null;
}

// Find THE single deterministic person for a candidate (or null + a reason). Tries the deterministic evidence
// in order; ANY signal that resolves to MORE THAN ONE person fails closed (ambiguous → review).
async function resolveDeterministicPerson(
  store: IdentityMatchWriteStore,
  candidate: AppUserMatchCandidate,
): Promise<{ personId: string; method: DeterministicMatchMethod } | { personId: null; reason: string }> {
  const email = normalizeEmail(candidate.email);
  const provider = typeof candidate.provider === "string" && candidate.provider.trim() ? candidate.provider.trim() : null;
  const externalId = typeof candidate.externalUserId === "string" && candidate.externalUserId.trim() ? candidate.externalUserId.trim() : null;

  // 1. exact app_user.email == person.primary_email
  if (email != null) {
    const byPrimary = await store.findPersonIdsByPrimaryEmail(email);
    if (byPrimary.length > 1) return { personId: null, reason: "multiple people share this email (primary) — review" };
    if (byPrimary.length === 1) return { personId: byPrimary[0], method: "auto_exact_email" };

    // 2. exact app_user.email == identity_accounts.email tied to a person
    const byIaEmail = await store.findPersonIdsByIdentityAccountEmail(email);
    if (byIaEmail.length > 1) return { personId: null, reason: "multiple people share this email (identity account) — review" };
    if (byIaEmail.length === 1) return { personId: byIaEmail[0], method: "auto_identity_account_email" };
  }

  // 3. exact provider external user id tied to an identity account / person
  if (provider != null && externalId != null) {
    const byExt = await store.findPersonIdsByExternalId({ provider, externalId });
    if (byExt.length > 1) return { personId: null, reason: "multiple people share this external id — review" };
    if (byExt.length === 1) return { personId: byExt[0], method: "auto_external_id" };
  }

  if (email == null && (provider == null || externalId == null)) {
    return { personId: null, reason: "no deterministic identity evidence (email or provider+external id)" };
  }
  return { personId: null, reason: "no deterministic person match found" };
}

// Match ONE app_user candidate deterministically (or leave it reviewable). Fail closed on every uncertainty.
async function matchOne(
  store: IdentityMatchWriteStore,
  authTenantId: string,
  candidate: AppUserMatchCandidate,
): Promise<IdentityMatchResult> {
  if (candidate == null || typeof candidate.appUserId !== "string" || candidate.appUserId.length === 0) {
    return { appUserId: candidate?.appUserId ?? "", outcome: "review", reason: "malformed candidate" };
  }
  // tenant safety — a candidate that claims a different tenant than the authenticated session is never matched.
  if (candidate.tenantId !== authTenantId) {
    return { appUserId: candidate.appUserId, outcome: "review", reason: "tenant mismatch" };
  }
  const resolved = await resolveDeterministicPerson(store, candidate);
  if (resolved.personId == null) {
    return { appUserId: candidate.appUserId, outcome: "review", reason: resolved.reason };
  }
  // conflict — an existing match to a DIFFERENT person is NEVER overwritten (repoint is an explicit, separate
  // operation). A match already pointing at THIS person is a no-op (idempotent).
  const existing = await store.getExistingMatchPersonId(candidate.appUserId);
  if (existing != null && existing !== resolved.personId) {
    return { appUserId: candidate.appUserId, outcome: "review", reason: "existing match points to a different person (conflict — no overwrite)" };
  }
  await store.upsertMatch({ appUserId: candidate.appUserId, personId: resolved.personId, matchMethod: resolved.method });
  return { appUserId: candidate.appUserId, outcome: "matched", reason: resolved.method, personId: resolved.personId, matchMethod: resolved.method };
}

// Apply deterministic identity matching to a set of app_user candidates (already RLS-read). Tenant scoping
// comes from the authenticated `authTenantId` + the RLS store: with no authenticated tenant this writes
// NOTHING. Idempotent (natural-key upsert) and order-independent.
export async function applyDeterministicIdentityMatches(
  store: IdentityMatchWriteStore,
  authTenantId: string | null | undefined,
  candidates: readonly AppUserMatchCandidate[],
): Promise<IdentityMatchResult[]> {
  if (typeof authTenantId !== "string" || authTenantId.length === 0) return [];
  const results: IdentityMatchResult[] = [];
  for (const candidate of candidates) results.push(await matchOne(store, authTenantId, candidate));
  return results;
}

// Non-destructive correction: repoint an app_user's existing deterministic match from one person to another
// (UPDATE person_id). It NEVER deletes the match, the app_user, the person, or any historical evidence.
export async function repointIdentityMatch(
  store: IdentityMatchWriteStore,
  authTenantId: string | null | undefined,
  input: { appUserId: string; fromPersonId: string; toPersonId: string },
): Promise<{ ok: boolean }> {
  if (typeof authTenantId !== "string" || authTenantId.length === 0) return { ok: false };
  if (input.fromPersonId === input.toPersonId) return { ok: false };
  await store.repointMatch(input);
  return { ok: true };
}
