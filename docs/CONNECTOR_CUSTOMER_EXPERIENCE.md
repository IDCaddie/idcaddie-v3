# Connector customer experience (P5E17)

**Status: the customer-facing connector experience is built as a PREVIEW.** A customer can browse the connector marketplace,
search/filter, open a connector's detail page, walk a simulated Okta connection wizard, and manage a "connected in preview"
connection. Everything is display + a simulated flow: **no live connector runs, no credentials are stored, no OAuth happens, no
provider is activated, and nothing syncs.** The preview connection lives only in the browser (`sessionStorage`).

This doc is the canonical description of the customer experience and its safety boundary. The Okta wizard specifics are in
[`OKTA_CUSTOMER_CONNECTION_FLOW.md`](./OKTA_CUSTOMER_CONNECTION_FLOW.md); the build evidence is in
[`evidence/P5E17_CONNECTOR_CUSTOMER_UI.md`](./evidence/P5E17_CONNECTOR_CUSTOMER_UI.md).

## Why preview-only

The connector runner, credential vault, and provider registry are all still gated. Okta and Microsoft Entra are
`certificationOnly` and non-runnable; RISK-007 is OPEN and Phase C is BLOCKED. So this phase builds the *experience* a customer
would use to connect an app — so we can see and refine it — WITHOUT touching any live path. The customer never sees internal
governance wording (certification state, RISK-007, pilot/ECS/credential/secret/task-definition/registry lifecycle); those map to
plain-language customer states in one central place.

## Information architecture

| Route | Purpose | Type |
|-------|---------|------|
| `/connectors` | Marketplace: browse / search / filter all connectors; each card shows its status | Server shell + `<ConnectorMarketplace/>` client island |
| `/connectors/[provider]` | Detail: value statement, what ID Caddie reads / never accesses, initial scope, setup time, CTA | Server + `<ConnectorDetailCta/>` island |
| `/connectors/[provider]/connect` | The simulated connection wizard (Okta this phase) | Server guard + `<OktaConnectWizard/>` island |
| `/connectors/[provider]/status` | Manage a preview connection (data access, sync settings, pause/reconnect/disconnect) | Server + `<ConnectorStatusView/>` island |
| `/connectors/review` | **Unchanged** operator sync-review workflow (role-gated confirm/reject) — linked from the marketplace footer | Pre-existing |
| `/connectors/oauth/callback` | **Unchanged** inert server-only OAuth callback route | Pre-existing |

Operator controls were not weakened: the review workflow and the OAuth callback route are untouched; the marketplace links to
review.

## Customer states and wording

Availability (from the catalog): **Preview** (a foundation exists; Okta is connectable in preview) or **Coming soon** (not built
yet). Connection status (from the browser preview state): **Connected** / **Paused** (both annotated "Preview mode"). The wizard
surfaces **Preview**, **Connected in preview mode**, **Not connected**; the management view surfaces **Manual first sync**,
**Scheduling unavailable in preview**, **Last sync: Never**, **Next sync: Not scheduled**. No internal lifecycle label is ever shown.

## The catalog (central internal→customer mapping)

`src/lib/customer-connectors/catalog.ts` is the single place internal connector state maps to safe customer cards. It is
server-only (it cross-checks the provider registry) and produces a plain, serializable `CustomerConnector` per provider. Twelve
curated providers are listed (Okta, Microsoft Entra ID, Slack, Google Workspace, Asana, Jira, Salesforce, Zoom, GitHub, Dropbox,
Adobe, HubSpot); the eight not-yet-built ones are "Coming soon"; the internal `scim_fixture` is never surfaced.

Two invariants hold for every card, defensively:

- `canSync === false` and `canSchedule === false` — nothing is live this phase.
- `canConnect` (offer the preview connect flow) is true **only** for Okta **and only if** the internal registry does not report
  the provider as ready. So a provider that ever became genuinely runnable could never be surfaced as a mere "preview."

The pure types + category constants live in `catalog-types.ts` (client-safe) so the client marketplace can use them without
pulling the server-only registry into the browser bundle.

## Preview/demo state (browser only)

`src/lib/customer-connectors/demo-store.ts` holds the preview connection in `sessionStorage` under one isolated key
(`idcaddie:demo-connectors:v1`). It stores only a per-provider status, the org host the customer typed, and a timestamp. It is a
no-op on the server, fails safe on blocked/corrupt storage, and is reset by clearing the one key. **It never writes a production
DB row, a connector record, a credential/OAuth/token/secret record, an ECS action, or a schedule.** The UI reads it reactively via
`useSyncExternalStore` so a connect/pause/disconnect updates every card and view live.

## Safety boundary (what this UI can NOT do)

No network request, no `fetch`, no OAuth redirect, no Okta API call, no token/secret/password field, no server action that mutates
connector tables, no ECS task, no schedule, no canonical promotion, no production target. These are enforced by the static safety
scan (`src/lib/customer-connectors/customer-connectors-safety.test.ts`) and the client/server boundary guard
(`no-client-import.test.ts`), plus runtime component tests that assert the wizard performs no navigation to Okta and writes only
the `sessionStorage` preview state. Okta and Microsoft Entra remain `certificationOnly`; RISK-007 remains OPEN; Phase C remains
BLOCKED.
