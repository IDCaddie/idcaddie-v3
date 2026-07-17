# Okta customer connection flow (P5E17)

The customer-facing **Okta** connection is a SIMULATED, clearly-labelled preview. It teaches the customer exactly what connecting
Okta would do — what ID Caddie reads, what it never touches, and how little setup it takes — **without any live path**: no OAuth
redirect, no network request, no Okta API call, no token/secret, no DB write. The only state it produces is a browser
`sessionStorage` preview connection on success.

See [`CONNECTOR_CUSTOMER_EXPERIENCE.md`](./CONNECTOR_CUSTOMER_EXPERIENCE.md) for the overall experience and safety boundary. The
customer copy + the SSRF-safe org-address validator live in `src/lib/customer-connectors/okta-content.ts`; the wizard is
`src/app/(authenticated)/connectors/[provider]/connect/okta-connect-wizard.tsx`.

## Detail page (`/connectors/okta`)

- Title **"Connect Okta"** + value statement (discover users and account status so ID Caddie can identify active / suspended /
  deactivated / unmanaged accounts).
- **What ID Caddie reads**: Users · User status · Approved profile identifiers · Pagination metadata.
- **What ID Caddie never accesses**: Passwords · MFA factors · Password resets · System logs · Application changes · Lifecycle
  changes · Write permissions.
- **Initial scope**: Users only · Read-only · No automatic scheduling · No canonical promotion. Setup time: about 2 minutes.
- CTA **"Connect Okta"** (+ "Learn how it works" anchoring the reads/never-access section).

## Wizard steps (`/connectors/okta/connect`)

A persistent amber "Preview mode" banner and a step indicator are shown throughout. The five happy-path steps:

1. **Organization** — the customer types their Okta org address. Validated by `validateOktaOrgHost` (below). Invalid input shows a
   plain-language, accessible error and stays on this step.
2. **Permissions** — shows the requested read-only scope `okta.users.read`, and that no passwords / MFA / app changes / writes are
   involved.
3. **Authorize (preview)** — an "Okta authorization preview" panel that explains that in production the customer would be
   redirected securely to Okta. **Right now nothing is contacted.** Two buttons drive the simulation: *Simulate approval* and
   *Simulate a failed approval* (plus Cancel). **There is no real redirect and no navigation to Okta.**
4. **Connection check** — a simulated checklist (organization verified · read-only permission approved · connection encrypted ·
   ready for supervised first sync), clearly labelled as simulated with no data imported.
5. **Success** — "Okta connected in preview mode." Ready for a supervised first sync; nothing imported. Links to View connection /
   Return to connectors / Disconnect preview.

*Simulate a failed approval* routes to a **Not connected** state ("no connection was made and no data was accessed") and writes
**no** preview state. Only completing step 5 writes the `sessionStorage` preview connection.

## Organization-address validation (SSRF-safe, no network)

`validateOktaOrgHost(raw)` normalizes and validates the typed address with **no network request**. It accepts only a bare
Okta-shaped hostname on an Okta apex (`.okta.com`, `.oktapreview.com`, `.okta-emea.com`); a leading `https://` is tolerated and
stripped. It rejects — with a distinct reason mapped to a plain-language message — any other scheme (`http:`, `javascript:`,
`data:`, …), embedded credentials (`user@…`), ports, paths / query / fragment / whitespace, `localhost` and internal/private
suffixes, IPv4 and IPv6 literals (bracketed or `::`), numeric TLDs, and non-Okta domains. It returns the normalized host or a
reason class — it never echoes a crafted value into anything executable. This mirrors the runner's own exact-host SSRF guard, at
the UI boundary. Covered by a table of accept/reject cases in `customer-connectors.test.ts`.

## Management (`/connectors/okta/status`)

Once "connected in preview," the customer can manage it: connection status (Connected / Paused, "Preview mode · No sync run yet"),
data access (Users · User status · Approved profile fields), security (read-only · least privilege · reauthorization not required),
and sync settings (First sync: Manual · Scheduling: Unavailable in preview · Last sync: Never · Next sync: Not scheduled).

Actions: **Run supervised first sync** is disabled with a safe explanation (the first sync isn't live yet; when it is, it runs
once, manually, under supervision — nothing runs automatically, nothing is imported in preview). **Pause / Resume** toggle only the
preview state. **Reconnect** restarts the simulated wizard. **Disconnect** clears only the local preview state. **No action here
launches a task, schedules anything, or authorizes execution server-side.**
