# 18 · OMC/Flywheel Confirmation Pass

**Canonical source for: the practical working process to confirm what OMC/Flywheel actually uses in
the current live app**, so doc 17's replacement parity matrix can be resolved from evidence instead of
assumption. This is the questionnaire + workshop + decision log that *feeds*
[17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md).

> **Read first:**
> - OMC/Flywheel is a **paying production replacement customer, NOT a pilot.** v3 must replace the live
>   app with no missing/broken workflows; improvements come only after replacement.
> - This doc's purpose is to **resolve the `probably`, `unknown`, and assumed-required rows** in doc 17.
> - **This doc does NOT make v3 ready.** Running the pass changes nothing about the product.
> - **This doc does NOT remove blockers by itself.** A blocker only changes status when evidence +
>   sign-off are recorded here AND the corresponding doc 17 row is updated.
> - **This doc feeds doc 17; [17](./17_OMC_PRODUCTION_REPLACEMENT_PARITY_GATE.md) remains the binding
>   cutover gate.** If 18 and 17 ever conflict on readiness, 17 wins. Cutover stays **BLOCKED**.

---

## 1. Purpose

- **Doc 17 is the go/no-go cutover gate** — the binding checklist that decides whether v3 may replace
  the live OMC app at all.
- **Doc 18 (this doc) is the confirmation workflow** — how we gather the evidence that lets doc 17's
  rows move off `probably`/`unknown`.
- The goal is to learn, with evidence: **what OMC actually uses**, **what they never use**, **what must
  be identical** at cutover, and **what can be approved as changed (`better-approved`) or removed
  (`removed-approved`)**.
- **`unknown` means blocker until confirmed.** This pass produces confirmations; it does not grant
  permission to skip a workflow. Nothing here lowers the cutover bar — it only replaces guesses with
  facts so doc 17 reflects reality.

---

## 2. Confirmation status taxonomy

Used by the §6 workflow table + §8 decision log. These describe **confirmation state of evidence**;
they map onto doc 17's parity statuses (last column below) only once recorded with owner + date.

| Status | Meaning | Maps to doc 17 |
|---|---|---|
| `confirmed-required` | OMC confirmed they use it; v3 must reproduce it (`same` or `better-approved`). | drives `same`/`partial`→must-close |
| `confirmed-not-used` | OMC confirmed they do not use it. | `not-used-by-OMC` |
| `confirmed-better-approved` | A documented v3 difference reviewed + accepted by OMC + ID Caddie (§8). | `better-approved` |
| `confirmed-removed-approved` | Legacy workflow deliberately dropped, explicitly accepted by OMC (§8). | `removed-approved` |
| `needs-demo` | Requires a live walkthrough/screen-share to confirm. | stays required until done |
| `needs-screenshot` | Requires a screenshot of the legacy screen/output. | stays required until done |
| `needs-data-sample` | Requires a (redacted) sample export/report/CSV to confirm format. | stays required until done |
| `needs-owner-confirmation` | Requires a named OMC owner to confirm use/non-use. | stays required until done |
| `needs-security-review` | Requires an ID Caddie security review before any decision (e.g. connector creds). | stays required until done |
| `unconfirmed-blocker` | Not yet confirmed; **treated as a required cutover blocker.** | blocker |

**Rules:**
- **Anything unconfirmed is treated as REQUIRED (a blocker) until proven otherwise** — consistent with
  doc 17 §1.4 ("silence is a blocker, not a pass") and §2 requiredness semantics.
- **A verbal "probably not used" is NOT enough for `removed-approved`/`not-used-by-OMC`.** Removal needs
  a recorded owner decision + evidence (a search of the live app, an owner sign-off, or an absence
  confirmation), logged in §8.
- **Every confirmation must record WHO confirmed it and WHEN** (and the evidence reference). An
  unattributed confirmation does not count.

---

## 3. OMC stakeholders / confirmation owners

Placeholders until real names are recorded (do not invent names — fill from a real engagement). One OMC
owner + one ID Caddie owner per area; a security reviewer is required wherever creds/PII/connectors are
involved.

| Area | OMC/Flywheel owner to confirm | ID Caddie owner | Evidence needed | Status |
|---|---|---|---|---|
| Login / auth / SSO | _OMC admin user_ | _ID Caddie technical owner_ + _ID Caddie security reviewer_ | demo of sign-in; is SSO/SAML used? | `unconfirmed-blocker` |
| Admin / settings / company | _OMC admin user_ | _ID Caddie product owner_ | which admin pages are used; role list | `unconfirmed-blocker` |
| Roles / permissions | _OMC admin user_ | _ID Caddie security reviewer_ | role→capability map; group access | `unconfirmed-blocker` |
| Apps (inventory/detail/roster/insights) | _OMC app owner/steward_ | _ID Caddie product owner_ | demo; which columns/filters/insights used | `unconfirmed-blocker` |
| Contracts | _OMC business owner_ | _ID Caddie product owner_ | demo; must-have fields; PDF/AI use | `unconfirmed-blocker` |
| People / identity / UAR | _OMC identity/IT owner_ | _ID Caddie security reviewer_ | demo; is IdP feed connected; UAR use | `unconfirmed-blocker` |
| Licenses / spend / invoices | _OMC finance/spend owner_ | _ID Caddie product owner_ | demo; license rules; invoice/proration use | `unconfirmed-blocker` |
| Imports / connectors | _OMC identity/IT owner_ | _ID Caddie technical owner_ + _ID Caddie security reviewer_ | which connectors are live (NO tokens) | `needs-security-review` |
| Exports / reports / dashboards | _OMC reporting consumer_ | _ID Caddie product owner_ | which reports run; (redacted) samples | `unconfirmed-blocker` |
| Files / PDF / AI | _OMC business owner_ | _ID Caddie technical owner_ | demo; upload/preview/AI use | `unconfirmed-blocker` |
| Billing / monthly reporting | _OMC finance/spend owner_ | _ID Caddie product owner_ | rate + count basis; is the invoice PDF used | `unconfirmed-blocker` |
| Audit / log history | _OMC admin user_ | _ID Caddie security reviewer_ | is the activity log used; needed granularity | `unconfirmed-blocker` |
| Production cutover / acceptance | _OMC business owner_ | _ID Caddie product owner_ | failed-cutover definition; signoff; rollback | `unconfirmed-blocker` |

---

## 4. Confirmation agenda (workshop)

A single 3-hour workshop (or split across sessions). Drive it from doc 17 §4; record into §6 + §8 here.

| Time | Segment |
|---|---|
| 15 min | **Explain the replacement principle** — production replacement, not a pilot; no missing/broken workflows; improvements come after parity. |
| 30 min | **Current-app walkthrough by OMC** — OMC drives, shows what they actually open day-to-day. |
| 45 min | **Workflow-by-workflow confirmation** — walk doc 17 §4 rows; mark each in §6 (used / not used / must-be-identical / can-change). |
| 30 min | **Reports / exports / connectors / imports review** — which reports run, which connectors are live, how imports work today. |
| 30 min | **Admin / security / auth review** — login method, SSO, roles, admin pages, audit/log use. |
| 30 min | **Must-have vs can-remove decisions** — for each candidate, decide `confirmed-required` / `better-approved` / `removed-approved` / `not-used`; record in §8. |
| 15 min | **Next actions + signoff owners** — assign follow-ups; name who signs off each area. |

**Evidence-collection instructions (during/after the workshop):**
- **Screen-record or screenshot** the key workflows **if OMC permits** (record permission in §8).
- **Collect sample exports/reports if allowed** — **with all sensitive values redacted** before they leave OMC.
- **Do NOT collect secrets or tokens.**
- **Do NOT collect production credentials.**
- **Do NOT ask for Okta / Slack / Google / any connector tokens or API keys in this pass.** Connector
  *existence* is confirmed verbally/visually; credential handling is a separate, later, security-reviewed
  step (the vault — RISK-007, designed in [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md), not yet implemented), never here.

---

## 5. Confirmation questionnaire

Grouped questions per area. Answers go into §6 (status) and §8 (decisions). Default every unanswered
question to `unconfirmed-blocker`.

### Core / admin / auth
- How do users log in today (email/password, SAML SSO, OIDC)?
- Is SSO **required at cutover**, or nice-to-have later?
- Which roles exist today, and what can each do?
- Who manages users and admin settings?
- Is tenant/company switching used (or single-company)?
- Which admin/settings pages are actually used?
- Is the audit/activity-log history used by admins? At what granularity (event vs field-level diff)?

### Apps
- Which app-inventory views are used (and which columns)?
- Which filters / search / sort matter day-to-day?
- Are the app-detail insights used (ELU, UAR, waste, sync health)?
- Are app-user rosters used? Which columns/badges?
- Are unmanaged / stale / orphaned account views used?
- Which app-metadata fields are actually edited?

### Contracts
- Are contract create/edit workflows used?
- Which contract fields are must-have?
- Are contract PDFs uploaded?
- Is AI extraction used / trusted?
- Are app↔contract links edited (and is per-app cost allocation % used)?
- Is the renewal / gantt view used?
- Are delete/archive workflows used?
- Are files / invoices attached to contracts?

### People / identity
- Is the people directory used?
- Is identity matching used?
- Are identity accounts inspected directly?
- Are unmanaged / orphaned / UAR workflows used?
- Are app-user→person matches reviewed or corrected by a human?

### Licenses / spend
- Are license rules configured?
- Are license evaluations / ELU / waste views used?
- Are spend / chargeback views used?
- Are invoices imported / uploaded?
- Are monthly billing / cost reports used?

### Imports / connectors
> Confirm which connectors **exist / are live** — verbal/visual only. **Do NOT request or record tokens, keys, or service-account JSON** (see §4/§10); credential handling is the separate later vault step (RISK-007, designed in [19_CONNECTOR_CREDENTIAL_VAULT_DESIGN](./19_CONNECTOR_CREDENTIAL_VAULT_DESIGN.md)).
- Which connectors are active today?
  - Okta?  Google Workspace?  Microsoft Entra?  Slack?  Salesforce?  HubSpot?  Atlassian?  Zoom?  SCIM?
- Which app scrapers are active?
- Which imports are manual CSV?
- Are imports destructive today (do they delete users not in the latest run)?
- What must be **non-destructive** in v3? (v3 will not port blind delete.)

### Exports / reports
- Which CSV exports are used?
- Which scheduled reports are used?
- Who receives emailed reports?
- Which report formats must match exactly (columns/order/semantics)?
- What report history matters (run history, past snapshots)?

### Files / PDF / AI
- Are PDFs uploaded?
- Are downloads used?
- Are file previews used?
- Is AI extraction trusted today?
- Is auto-overwrite (AI writes fields directly) expected today?
- Is **review/apply** (AI suggests; a human accepts) acceptable as safer behavior?

### Production cutover
- What would count as a **failed cutover**?
- Which workflows must be tested by OMC **before** the switch?
- Who signs off?
- Is a **parallel run** required (old + new in parallel)?
- How long must the old app remain available after cutover?
- What rollback expectation exists?

---

## 6. Workflow confirmation table

Mirrors doc 17 §4 at a higher level. **Initial status is `unconfirmed-blocker` or `needs-owner-confirmation`
for every row — nothing is confirmed yet.** Update from the workshop; then update the matching doc 17 row.

| Workflow area | Doc 17 row(s) | Current assumption | Confirmation question | Evidence needed | OMC answer | Resulting status | Cutover impact | Follow-up PR/action |
|---|---|---|---|---|---|---|---|---|
| login / auth / session | 4.1 auth (email/pw, SSO) | email/pw partial; SSO unknown | How do users log in; is SAML required? | demo | _TBD_ | `unconfirmed-blocker` | blocker if SSO required | B-admin |
| admin / settings / company | 4.1 admin/company | not built | Which admin/settings pages are used? | demo/screenshot | _TBD_ | `needs-owner-confirmation` | blocker if used | B-admin |
| roles / permissions | 4.1 admin/users, groups | partial (RLS only) | Which roles; who administers? | role list (no secrets) | _TBD_ | `unconfirmed-blocker` | blocker | B-admin |
| app inventory | 4.2 inventory | partial (4 cols) | Which columns/filters used? | demo/screenshot | _TBD_ | `unconfirmed-blocker` | blocker | B-apps |
| app detail | 4.2 detail/metrics | partial | Which detail metrics relied on? | demo | _TBD_ | `unconfirmed-blocker` | blocker | B-apps |
| app users (roster) | 4.2 roster | partial | Roster columns/filters used? | demo | _TBD_ | `unconfirmed-blocker` | blocker | B-people |
| app metadata / edit | 4.2 detail/edit | not built | Which fields edited? | demo | _TBD_ | `unconfirmed-blocker` | blocker | B-apps |
| account intelligence | 4.2 account intel | better-approved (PII-free) | Which insight semantics relied on? | demo | _TBD_ | `needs-owner-confirmation` | confirm interim OK | B-people |
| contracts list/detail | 4.3 list, detail | partial | KPIs/filters used? | demo/screenshot | _TBD_ | `unconfirmed-blocker` | blocker | B-contracts |
| contract create/edit | 4.3 create blank, edit | same/partial | Must-have fields; status set; cost model? | demo | _TBD_ | `needs-owner-confirmation` | confirm cost semantics | B-contracts |
| contract PDF upload | 4.3 create via PDF | not built | Are PDFs uploaded? | demo | _TBD_ | `unconfirmed-blocker` | blocker if used | A-storage |
| AI extraction | 4.3 AI analysis | not built | Is AI used/trusted; review-apply OK? | demo | _TBD_ | `needs-owner-confirmation` | confirm review/apply | A-extraction |
| app-contract link/unlink | 4.3 links/allocation | partial (read-only) | Is linking + allocation % used? | demo | _TBD_ | `needs-owner-confirmation` | blocker if used | B-apps |
| renewal / gantt | 4.3 gantt | not built | Is gantt used for planning? | demo/screenshot | _TBD_ | `needs-owner-confirmation` | blocker if used | B-contracts |
| contract files | 4.3 files | not built | Are files attached/viewed? | demo | _TBD_ | `unconfirmed-blocker` | blocker if used | A-storage |
| people directory | 4.4 directory | not built | Is the directory used? | demo | _TBD_ | `needs-owner-confirmation` | blocker if IdP feed | B-people |
| identity accounts | 4.4 (accounts) | default-deny | Are accounts inspected directly? | demo | _TBD_ | `needs-owner-confirmation` | confirm need | B-people |
| identity matching | 4.4 matching | not built | Is matching used; rules configured? | demo/settings | _TBD_ | `unconfirmed-blocker` | blocker if IdP feed | B-people |
| unmanaged / orphaned / UAR | 4.2/4.4 UAR, risk | not built | Is UAR/Critical-Risk used? | demo/screenshot | _TBD_ | `unconfirmed-blocker` | blocker if IdP feed | B-people |
| license rules | 4.5 rules | not built | Are license rules configured? | demo/screenshot | _TBD_ | `needs-owner-confirmation` | blocker if used | B-licenses |
| license evaluations / ELU | 4.5 eval, ELU | not built | Are ELU/waste views used? | demo | _TBD_ | `needs-owner-confirmation` | blocker if used | B-licenses |
| spend / chargeback | 4.5 cost rollup, IT-spend | not built | Are spend/chargeback views used? | demo/sample | _TBD_ | `unconfirmed-blocker` | blocker if used | B-reports |
| invoices | 4.5 invoices | not built | Are invoices uploaded/reviewed? | demo | _TBD_ | `unconfirmed-blocker` | blocker if used | B-licenses |
| Okta / IdP connector | 4.6 okta | not built | Is Okta the live IdP? | verbal/visual (NO token) | _TBD_ | `needs-security-review` | blocker if live | B-connectors |
| Google / Microsoft connector | 4.6 google, long-tail | not built | Google/Entra connectors live? | verbal/visual (NO token) | _TBD_ | `needs-security-review` | blocker if live | B-connectors |
| Slack connector | 4.6 long-tail | not built | Is Slack connected? | verbal/visual (NO token) | _TBD_ | `needs-security-review` | blocker if live | B-connectors |
| SCIM | 4.1/4.6 SCIM | not built | Is SCIM provisioning used? | verbal/visual (NO token) | _TBD_ | `needs-security-review` | blocker if used | B-connectors |
| app scrapers | 4.2 scraping | not built | Which scrapers active? | verbal/visual (NO token) | _TBD_ | `needs-security-review` | blocker if live | B-connectors |
| imports | 4.6 upsert, manual CSV | not built | Manual CSV used; destructive today? | demo/sample (redacted) | _TBD_ | `unconfirmed-blocker` | blocker; must be non-destructive | B-connectors |
| exports | 4.2/4.3/4.7 export | not built | Which CSV exports used? | sample (redacted) | _TBD_ | `unconfirmed-blocker` | blocker if used | B-reports |
| scheduled reports | 4.7 schedules | not built | Active schedules; recipients? | sample (redacted) | _TBD_ | `needs-data-sample` | blocker if active | B-reports |
| audit / log history | 4.1 logging | partial | Is the log used; granularity? | demo | _TBD_ | `needs-owner-confirmation` | confirm granularity | B-admin |
| billing / monthly reports | 4.5 revenue | not built | Rate + count basis; PDF sent? | owner confirm | _TBD_ | `unconfirmed-blocker` | revenue-critical | B-billing |
| hosted / staging / cutover ops | 4.9 ops | not built | Parallel run; rollback; signoff? | owner confirm | _TBD_ | `unconfirmed-blocker` | hard gate | A/B-ops |

---

## 7. Evidence collection checklist

Collect **only** the following, and **only** what OMC permits. **Redact sensitive values before anything
leaves OMC.** (See §10 non-goals — no secrets, ever.)

- [ ] Screenshots / recordings of the core workflows (with OMC permission).
- [ ] List of active users / roles — **counts + role names only, NO passwords/secrets**.
- [ ] List of active connectors — **names only, NO tokens / API keys / service-account JSON**.
- [ ] Sample CSV exports — **sensitive values redacted**.
- [ ] Sample scheduled-report emails — **sensitive values redacted**.
- [ ] List of currently-used reports (which run, who receives them).
- [ ] List of must-have **contract** fields.
- [ ] List of must-have **app** fields.
- [ ] List of must-have **import** formats.
- [ ] List of must-have **export** formats.
- [ ] Current billing / reporting expectations (rate, count basis, who receives the invoice).
- [ ] Current cutover / rollback expectations (parallel run, freeze window, old-app availability).

---

## 8. Decision log template

Every classification change is recorded here, with owner + date + evidence. **A row without
`Confirmed by` + `Evidence` does not count** (see §2 rules). This log is the support for any
`better-approved` / `removed-approved` / `not-used-by-OMC` claim in doc 17.

| Date | Decision | Workflow | Legacy behavior | v3 target behavior | Classification | Confirmed by | Evidence | Follow-up PR |
|---|---|---|---|---|---|---|---|---|
| _YYYY-MM-DD_ | _e.g. drop blind-delete import_ | _imports_ | _hard-deletes users not in run_ | _non-destructive upsert + soft-delete + preview_ | `better-approved` | _OMC owner + IDC owner_ | _§7 ref / screenshot_ | _B-connectors_ |

**Classifications:** `same` · `better-approved` · `removed-approved` · `not-used-by-OMC` · `blocked`.

- `better-approved` / `removed-approved` require **both** an OMC owner **and** an ID Caddie owner, plus
  evidence. This strengthens doc 17 §6 (whose numbered step names the ID Caddie product/cutover owner;
  OMC acceptance is required by §6's worked examples + §1) — "better" is never a developer-preference decision.
- `not-used-by-OMC` requires a recorded owner confirmation (not a verbal "probably").
- `blocked` is the default; it stays blocked until a row here moves it.

---

## 9. Output of the confirmation pass

After running this pass, the following must be produced (and recorded in doc 17 + the changelog):

- **Doc 17 §4 rows updated** with confirmed statuses (every `probably`/`unknown` resolved to `yes`/`no`;
  every relevant row re-classified per §8) — see doc 17 §5 checklist.
- **Blocker list split into required vs not-used** (doc 17 §3 + §4), with the `not-used-by-OMC` items removed from the cutover path.
- **PR sequence re-estimated** (doc 17 §7/§8) against the confirmed scope (the ~70–110 range narrows to the confirmed set).
- **Connector list confirmed** (which of Okta/Google/Entra/Slack/Salesforce/HubSpot/Atlassian/Zoom/SCIM/scrapers are actually live).
- **Report / export list confirmed** (which reports + formats must match exactly).
- **Cutover acceptance test plan drafted** (the OMC-run validation list for doc 17 §5).
- **Production replacement scope signed off** (the confirmed required-workflow set + owners).

**None of these outputs makes v3 ready** — they make doc 17 *accurate*. Cutover stays blocked until every
doc 17 §5 box is true.

---

## 10. Non-goals (do not do these in this pass)

- **No secret collection.**
- **No API token collection** (no Okta/Slack/Google/connector tokens or keys).
- **No production data import.**
- **No hosted Supabase apply** (no `supabase db push --linked`, no migration apply).
- **No production deploy.**
- **No feature implementation** (this is docs/process only; build happens in later, tested PRs).
- **No readiness claim.** This pass de-risks and sizes the replacement; it does not declare v3 ready,
  and it does not close RISK-002 or RISK-016.
