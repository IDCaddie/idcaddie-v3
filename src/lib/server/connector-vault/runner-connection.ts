// Runner-safe connection primitives, split out of `runner-db-client.ts` (which is coupled to the OAuth-pending
// subsystem via value imports) so the SEPARATE hosted runner (doc 46 §11) can VENDOR just these — a small, clean,
// dependency-free core — without dragging in OAuth code. Pure types + a trivial error: NO imports, NO DB driver, NO
// secret, NO side effect. `runner-db-client.ts` re-exports these, so existing importers are unchanged (back-compat).

export class RunnerDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerDbError";
  }
}

// The low-level injected runner connection — a server-only Postgres session bound to `connector_runner_login`
// that the FUTURE hosted runner provides. `runSequence` runs the given parameterized statements IN ORDER on
// ONE connection (so a leading `set role connector_runner` applies to the statements after it). NEVER a
// service-role / global client; NEVER reachable from request/browser code. Tests inject a mock.
export interface RunnerConnection {
  runSequence(
    statements: ReadonlyArray<{ sql: string; params: readonly unknown[] }>,
  ): Promise<Array<{ rows: ReadonlyArray<Record<string, unknown>> }>>;
}
