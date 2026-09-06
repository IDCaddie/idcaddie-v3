# GWS-E4b — creating the Google Workspace connector row

**Status: NOT EXECUTED. This document authorizes nothing.** It records the exact single write, the preconditions that
gate it, and the order it sits in. Executing it is a separate, explicit decision.

## Why this is a runbook and not an RPC

`public.connectors` is writable by exactly two principals: `service_role` (Supabase default, bypasses RLS) and a
`security definer` function running as owner. `0018` revokes **all** on the table from `anon` and `authenticated` and
grants back `select` only, so no browser role can insert under any policy. `0052` records the standing posture in its
own words — *"connection_state is otherwise mutated only by service_role off-box"* — and the Okta precedent at this same
certification stage is the same mechanism.

The Okta creation RPC, `create_okta_connector_configuration` (0063), is granted to `authenticated` and gated on
`has_tenant_role(owner|admin)` because it serves a product flow. Google has no such flow: the provider registry declares
`google_workspace` as `status: "future", enabled: false`, so `isConnectorProviderReady("google_workspace")` returns
`false`. An `authenticated` RPC would be unreachable machinery encoding a product decision nobody has made.

Google also needs no configuration table. 0092's evidence table keys on `(tenant_id, connector_id)` and reads no config;
the service-account address, impersonated admin and customer id arrive as task-definition environment and are read by
nothing in this database. A config table would be a table with no reader.

So the smallest correct mechanism is one reviewed `service_role` INSERT of one row.

## Preconditions — every one required before this write

| Gate | Requirement |
|---|---|
| GWS-E4 | Migration `0086` confirmed **applied** to hosted staging. Zero-write probe below. |
| GWS-E1 | A real Google signing key exists, with bounded `kms:Sign` for `idcaddie-staging-google-workspace-task`. |
| GWS-E2 | Domain-wide delegation granted for exactly the four approved scopes. |
| GWS-E3 | **A live verify has actually succeeded.** |
| 0092 | Applied to hosted staging (a separate authorized step). |

**The row must not be created before verify succeeds.** A row created early sits at `configured` with no evidence to
earn `verified` and no way to acquire it later.

Zero-write probe for GWS-E4:

```sql
select proname from pg_proc
 where proname in ('runner_promote_directory_users', 'runner_assert_parameterized_provider');
select 1 from public.connector_discovery_policy where provider = 'google_workspace';
```

## Step 1 — pre-check, and STOP if a row exists

`public.connectors` carries **no** uniqueness on `(tenant_id, provider)` — `0017` creates plain indexes only, and every
uniqueness rule Okta has lives in `okta_connector_configs`, a table Google does not have. Idempotency here is therefore
procedural, and this step is the whole of it.

```sql
select id, connection_state, status
  from public.connectors
 where tenant_id = :tenant_id and provider = 'google_workspace';
```

**If this returns any row: stop. Use it. Do not insert.** Two Google connector rows in one tenant is the failure this
step exists to prevent — the runner takes `GOOGLE_WORKSPACE_CONNECTION_ID` from the environment, so a duplicate becomes
a silently wrong binding the moment someone pastes the wrong id.

## Step 2 — the write

One row. One statement. Executed once.

```sql
insert into public.connectors
  (tenant_id, provider, display_name, status, connection_state, granted_scopes_safe)
values
  (:tenant_id,
   'google_workspace',
   'Google Workspace',
   'pending',
   'configured',
   array['https://www.googleapis.com/auth/admin.directory.user.readonly',
         'https://www.googleapis.com/auth/admin.directory.group.readonly',
         'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
         'https://www.googleapis.com/auth/apps.licensing']::text[])
returning id;
```

`connection_state` is `'configured'` and **must be visible as such in the statement that is reviewed.**
`'verified'` here is forbidden: 0092 accepts only `configured` as a start state, so a row forced to `verified` can never
have evidence recorded against it — the forced flag would be permanent and permanently unbacked.

Deliberately unset: `connected_by` (no profile authors a certification row), `organization_id`, `last_sync_at`,
`health`, `superseded_by`. `status` stays `pending`; nothing in this sequence advances it.

## Step 3 — record the returned id

The returned `id` becomes `GOOGLE_WORKSPACE_CONNECTION_ID`, and `:tenant_id` becomes `GOOGLE_WORKSPACE_TENANT_ID`, in
the Google task definitions. Both are covered by the runner's placeholder guard, so an unresolved value refuses before
any signing, token request or database work.

| Field | Value |
|---|---|
| `connectors.id` | _record here_ |
| `tenant_id` | _record here_ |
| Created at (UTC) | _record here_ |
| Authorized by | _record here_ |
| Verify run that gated it | _record here_ |

## What happens next, and by whom

| # | Actor | Action | State after |
|---|---|---|---|
| 1 | operator | confirm 0086 + 0092 applied | — |
| 2 | runner | **verify** — DB-free, no row, token discarded | — |
| 3 | `service_role` | **this runbook** | `configured` |
| 4 | `connector_runner` | recording pass: open run, re-perform the verification, call `runner_record_google_workspace_validation` | `verified` |
| 5 | runner | aggregate — read-only, no DB | `verified` |
| 6 | runner | persist | `discovered` |

Step 4 re-performs the verification rather than transcribing step 2's verdict. That is the point: the evidence must be
what the runner observed in the run it is recording, not a value a human carried across from an earlier console output.

## The residual risk, stated plainly

`service_role` could set `connection_state = 'verified'` directly, and no DDL closes that — a principal that can bypass
RLS can also alter the DDL meant to stop it. The control is procedural: one reviewed statement, reviewed before
execution, with `'configured'` visible in it. 0092 makes `verified` *earnable* and makes a forced flag *useless*; it
cannot make a forced flag *impossible*. Claiming otherwise would be false.
