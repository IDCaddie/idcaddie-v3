# Okta customer connection flow (P5E17)

The customer-facing **Okta** connection is a SIMULATED, clearly-labelled preview. It teaches the customer exactly what connecting
Okta would do — what ID Caddie reads, what it never touches, and how little setup it takes — **without any live path**: no OAuth
redirect, no network request, no Okta API call, no token/secret, no DB write. The only state it produces is a browser
`sessionStorage` preview connection on success.

See [`CONNECTOR_CUSTOMER_EXPERIENCE.md`](./CONNECTOR_CUSTOMER_EXPERIENCE.md) for the overall experience and safety boundary. The
customer copy + the SSRF-safe org-address validator live in `src/lib/customer-connectors/okta-content.ts`; the wizard is
`src/app/(authenticated)/connectors/[provider]/connect/okta-connect-wizard.tsx`.

> **P5E17b polish:** the detail page is a constrained (~1120px) two-column hero (identity + value on the left; the primary CTA +
> setup time on the right); the wizard is four customer-facing steps inside a centered setup card. Wording/structure below reflect
> that pass.

## Detail page (`/connectors/okta`)

- Hero heading **"Okta"** · category · a single **Preview** badge, with the value statement "Discover users and account status
  from your Okta organization." The primary CTA **"Connect Okta"** + **"Setup takes about 2 minutes"** sit in the right column; a
  subtle text link **"See what ID Caddie can access"** scrolls to the access cards (the old "Learn how it works" button is gone).
- **What ID Caddie can access**: Users · Account status · Basic profile information, such as name, username, and email address.
- **What ID Caddie cannot access**: Passwords · MFA information · Password resets · System logs · Application changes · Account
  lifecycle changes · Write permissions.
- **Initial scope**: three chips — Users only · Read-only · No automatic sync — with one line: "Nothing is imported until the
  connection is approved and the first sync is started."

## Wizard steps (`/connectors/okta/connect`)

The wizard is a centered setup card on a clean page background, with ONE preview banner and a strong **"Step N of 4"** progress
bar. Four customer-facing steps:

1. **Organization** — "Your Okta organization" · "Enter the address your team uses to sign in to Okta." The customer types their
   Okta address (a bare label like `acme` is normalized to `acme.okta.com`; a **Use a custom Okta domain** advanced toggle disables
   that so a full address can be entered). Validated by `validateOktaOrgHost` (below, UNCHANGED and strict). Invalid input shows a
   plain-language, `role="alert"` error and stays on this step.
2. **Permissions** — "ID Caddie requests read-only access to:" View users · View account status · View basic profile information,
   plus the one technical scope `okta.users.read` and the reassurance "ID Caddie cannot change users, passwords, MFA settings, or
   applications."
3. **Authorize** — a neutral **"Authorize with Okta"** preview panel: "In the live version, you'll be redirected securely to Okta
   to approve read-only access." (No Okta-branding mimicry.) Buttons: *Simulate approval* / *Simulate a failed approval* / Cancel.
   **No real redirect and no navigation to Okta.** *Simulate approval* shows the concrete checks (Okta organization confirmed ·
   Read-only access approved · No data imported yet · Ready for first sync) folded into this step, then **Complete connection**.
4. **Connected** — "Okta connected in preview mode." Ready for a supervised first sync; nothing imported. Links to View connection /
   Return to connectors / Disconnect preview.

*Simulate a failed approval* routes to a terminal **Not connected** state ("no connection was made and no data was accessed") and
writes **no** preview state. Only completing step 3→4 writes the `sessionStorage` preview connection. Terminal states drop the
progress bar and are never announced as a numbered step.

## Organization-address validation (SSRF-safe, no network)

`validateOktaOrgHost(raw)` normalizes and validates the typed address with **no network request**. It accepts only a bare
Okta-shaped hostname on an Okta apex (`.okta.com`, `.oktapreview.com`, `.okta-emea.com`); a leading `https://` is tolerated and
stripped. It rejects — with a distinct reason mapped to a plain-language message — any other scheme (`http:`, `javascript:`,
`data:`, …), embedded credentials (`user@…`), ports, paths / query / fragment / whitespace, `localhost` and internal/private
suffixes, IPv4 and IPv6 literals (bracketed or `::`), numeric TLDs, and non-Okta domains. It returns the normalized host or a
reason class — it never echoes a crafted value into anything executable. This mirrors the runner's own exact-host SSRF guard, at
the UI boundary. `normalizeOrgInput` (P5E17b) only expands a **bare single label** to `<label>.okta.com` before this validator
runs — anything already qualified / `https://` / custom-domain mode passes through unchanged, so no new host shape is ever
accepted. Covered by accept/reject tables in `customer-connectors.test.ts`.

## Management (`/connectors/okta/status`)

Once "connected in preview," the customer manages it from a header (name · **Connected / Paused** badge · **Preview**) + summary
("Ready for a supervised first sync") and four sectioned panels: **Connection status** (Connected/Paused · No sync has run),
**Data access** (Users · Account status · Basic profile information), **Sync** (First sync: Not started · Last sync: Never ·
Scheduling: Unavailable during preview), **Security** (Read-only · Only the access listed above · Reauthorization not required).

Actions: **Run supervised first sync** is `aria-disabled` (stays focusable so its explanation is announced) with a plain-language
note (the first sync isn't available yet; when it is, it runs once, manually, under supervision — nothing runs automatically,
nothing is imported during preview). **Pause / Resume** toggle only the preview state. **Reconnect** restarts the simulated
wizard. **Disconnect** clears only the local preview state. **No action here launches a task, schedules anything, or authorizes
execution server-side.**
