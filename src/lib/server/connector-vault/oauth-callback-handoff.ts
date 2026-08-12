// Phase 8K — the REAL Slack OAuth callback: validate, seal, hand off, and tell the customer the truth. Server-only.
//
// What this path does NOT do is the point of it. It does not read the Slack client secret, does not construct a KMS
// client, does not open a database connection, does not call `oauth.v2.access`, and does not consume the pending row.
// Every one of those belongs to the completion worker, which is a separate deployable holding the private half of the
// sealing key and the `oauth_completer` database identity. The web tier's entire job is: prove the callback is the one
// it authorized, seal the authorization code so only the worker can read it, and hand it over.
//
// So this route CANNOT report "Connected". It reports that a completion is in progress, and the customer's browser goes
// to a page whose only source of truth is migration 0081's bounded status read. A route that said "success" here would
// be guessing about work that has not happened yet — the exact lie doc 83 exists to prevent.
//
// Every refusal is a bounded static code. The authorization code, the sealed payload, the OIDC assertion, the state and
// any configured value are never logged, echoed, put in a response body or header, or returned to the browser. Nothing
// in this file calls `console.*`.
//
// SERVER-ONLY: under `src/lib/server/`, the runtime browser sentinel below, and `no-client-import.test.ts` (only the
// callback route may import it from src/app).

import { validateOAuthState, type OAuthStateReason, type OAuthStateSigner } from "./oauth-state";
import { hashOAuthValue } from "./oauth-pending";
import {
  HANDOFF_ENVIRONMENT,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_PROVIDER,
  HANDOFF_REDIRECT_URI,
  type HandoffRequest,
} from "./oauth-handoff-protocol";
import { PayloadSealError, sealAuthorizationCode, type SealRefusal } from "./oauth-payload-seal";
import {
  preflightOwnAssertion,
  submitHandoff,
  type HandoffFetch,
  type HandoffRefusal,
  type WorkerHandoffConfig,
} from "./oauth-handoff-client";

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("connector-vault/oauth-callback-handoff is server-only and must not be imported in client code");
}

/** Where a customer waits for the truth. The correlation id is the only thing it carries, and it is server-supplied. */
export const PENDING_PATH = "/connectors/oauth/pending" as const;
const ERROR_PATH = "/connectors" as const;

/** `oauth_pending.subject` is a uuid column and the protocol schema requires the same shape. Checked here so a
 *  malformed subject is refused at the source rather than as a late schema failure at the worker. */
const SUBJECT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type HandoffCallbackRefusal =
  | OAuthStateReason
  | SealRefusal
  | HandoffRefusal
  | "authorization_code_missing"
  | "provider_reported_error"
  | "session_required";

export type HandoffCallbackResult =
  | { ok: true; correlationId: string; outcome: "accepted" | "duplicate" }
  | { ok: false; reason: HandoffCallbackRefusal };

/** The server-trusted context, from the environment-identity gate. Not one field of it comes from the request. */
export type HandoffExpectedContext = {
  tenantId: string;
  connectorId: string;
  correlationId: string;
  expectedTeamId: string;
  redirectUri: string;
};

export type HandoffCallbackDeps = {
  signer: OAuthStateSigner;
  expected: HandoffExpectedContext;
  config: WorkerHandoffConfig;
  /** Reads the Vercel OIDC assertion from the environment. Injected so a test never needs a real one. */
  readAssertion: () => Promise<string | null>;
  fetchImpl: HandoffFetch;
  now: () => number;
};

export type HandoffCallbackRunner = (input: {
  state?: string;
  code?: string;
  providerError?: string;
  subject: string;
}) => Promise<HandoffCallbackResult>;

export function makeHandoffCallbackRunner(deps: HandoffCallbackDeps): HandoffCallbackRunner {
  return async ({ state, code, providerError, subject }) => {
    // Slack said no (`?error=access_denied`). Its value is never surfaced — only that the provider refused.
    if (typeof providerError === "string" && providerError.length > 0) {
      return { ok: false, reason: "provider_reported_error" };
    }

    // The configured callback and the protocol's pinned callback must be the same string. The environment gate already
    // requires it, and migration 0081 CHECKs it a third time; asserting it here as well means the URI the state is
    // validated against is provably the URI that gets sealed into the AAD and written to the job.
    if (deps.expected.redirectUri !== HANDOFF_REDIRECT_URI) return { ok: false, reason: "redirect_uri_mismatch" };

    // 1. The signed state, checked against server-trusted context BEFORE the authorization code is touched. A callback
    //    for another tenant, connector, subject, redirect or correlation never gets as far as being sealed.
    const validated = validateOAuthState(
      state,
      {
        subject,
        tenantId: deps.expected.tenantId,
        connectorId: deps.expected.connectorId,
        provider: HANDOFF_PROVIDER,
        redirectIntent: "connect",
        redirectUri: deps.expected.redirectUri,
        correlationId: deps.expected.correlationId,
      },
      { signer: deps.signer, now: deps.now() },
    );
    if (!validated.ok) return { ok: false, reason: validated.reason };

    if (typeof code !== "string" || code.length === 0) return { ok: false, reason: "authorization_code_missing" };

    // 1b. PROTOCOL v2 — the two trusted values the worker needs to consume the pending row, taken from the state that
    //     was just AUTHENTICATED above and from nowhere else.
    //
    //     THE RAW NONCE NEVER LEAVES THIS PROCESS. `hashOAuthValue` is the same sha256 the authorize half used to
    //     write `oauth_pending.nonce_hash`, so what travels is the value the database already holds — the hash of a
    //     single-use CSRF secret, not the secret. The database has never stored the raw nonce either (doc 42 §32.3).
    //
    //     `sub` is the `auth.uid()` the state binds, and `validateOAuthState` has just compared it against the live
    //     session, so it cannot be widened by a request: a callback presenting another user's state was refused above.
    //     It is an opaque UUID — never an email, a name, or anything a person reads.
    const nonceHash = hashOAuthValue(validated.payload.nonce);
    const boundSubject = validated.payload.sub;
    // The GRAMMAR, not merely presence. `validateOAuthState` already guarantees `sub` is a non-empty string (it
    // returns `malformed_state` otherwise), so an emptiness check here would be dead code reading as a live guard.
    // What it does NOT guarantee is that the value is a UUID — and `oauth_pending.subject` is a uuid column, so a
    // non-UUID subject would fail the protocol schema at the worker as a late, confusing refusal instead of here as a
    // precise one. Refused rather than sent as null, too: `is not distinct from` would happily match null against some
    // OTHER subject-less row. (Found in adversarial review of PR #400.)
    if (typeof boundSubject !== "string" || !SUBJECT_UUID_RE.test(boundSubject)) {
      return { ok: false, reason: "malformed_state" };
    }

    // 2. Seal. From here the plaintext exists only inside `sealAuthorizationCode`, and only for the length of one call.
    let sealed;
    try {
      sealed = sealAuthorizationCode(code, deps.config.workerKey, {
        tenantId: deps.expected.tenantId,
        connectorId: deps.expected.connectorId,
        correlationId: deps.expected.correlationId,
        expectedTeamId: deps.expected.expectedTeamId,
        payloadKeyId: deps.config.workerKey.keyId,
        nonceHash,
        subject: boundSubject,
      });
    } catch (error) {
      return { ok: false, reason: error instanceof PayloadSealError ? error.reason : "seal_failed" };
    }

    const request: HandoffRequest = {
      version: HANDOFF_PROTOCOL_VERSION,
      environment: HANDOFF_ENVIRONMENT,
      correlationId: deps.expected.correlationId,
      tenantId: deps.expected.tenantId,
      connectorId: deps.expected.connectorId,
      provider: HANDOFF_PROVIDER,
      redirectUri: HANDOFF_REDIRECT_URI,
      expectedTeamId: deps.expected.expectedTeamId,
      payloadScheme: sealed.payloadScheme,
      payloadKeyId: sealed.payloadKeyId,
      protectedPayload: sealed.protectedPayload.toString("base64"),
      nonceHash,
      subject: boundSubject,
    };

    // 3. The assertion, sanity-checked against our own configuration before it leaves. The worker is the authority on
    //    whether it is valid; this only stops us presenting one that was minted for somebody else.
    const assertion = await deps.readAssertion();
    const preflight = preflightOwnAssertion(assertion, {
      audience: deps.config.audience,
      nowSeconds: Math.floor(deps.now() / 1000),
    });
    if (!preflight.ok) return { ok: false, reason: preflight.reason };

    const submitted = await submitHandoff(request, {
      endpoint: deps.config.endpoint,
      assertion: assertion as string,
      fetchImpl: deps.fetchImpl,
    });
    if (!submitted.ok) return { ok: false, reason: submitted.reason };

    return { ok: true, correlationId: deps.expected.correlationId, outcome: submitted.ack.status };
  };
}

// ── The request-path handler ─────────────────────────────────────────────────────────────────────────────────────────

const noStore = (location: string): Response =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/** A bounded failure. `reason` is one of the codes above — never an env value, host, token, code or exception text. */
export function handoffErrorRedirect(reason: string): Response {
  return noStore(`${ERROR_PATH}?oauth=error&reason=${encodeURIComponent(reason)}`);
}

/**
 * The callback handler. Same shape as the synthetic one (session → parse → run → safe response) and the same
 * disclosure rules; what differs is the success destination, because there is no success yet to report.
 */
export async function handleHandoffCallback(
  request: Request,
  deps: { resolveSubject: () => Promise<string | null>; run: HandoffCallbackRunner },
): Promise<Response> {
  let subject: string | null;
  try {
    subject = await deps.resolveSubject();
  } catch {
    return handoffErrorRedirect("session_required");
  }
  if (typeof subject !== "string" || subject.length === 0) return handoffErrorRedirect("session_required");

  let state: string | undefined;
  let code: string | undefined;
  let providerError: string | undefined;
  try {
    const url = new URL(request.url);
    state = url.searchParams.get("state") ?? undefined;
    code = url.searchParams.get("code") ?? undefined;
    providerError = url.searchParams.get("error") ?? undefined;
  } catch {
    return handoffErrorRedirect("malformed_state");
  }

  let result: HandoffCallbackResult;
  try {
    result = await deps.run({ state, code, providerError, subject });
  } catch {
    return handoffErrorRedirect("seal_failed");
  }
  if (!result.ok) return handoffErrorRedirect(result.reason);

  // PENDING, not connected. The correlation id is the server's own configured value, not anything the request supplied.
  return noStore(`${PENDING_PATH}?c=${encodeURIComponent(result.correlationId)}`);
}
