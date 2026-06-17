# 15 · Legacy Contract Create/Edit — Inspection Note (for PR #31)

**Canonical source for: what the legacy contract create/edit workflow actually does**, captured by
reading the legacy sources **before** building the v3 contract write UI (PR #31). Required by the
parity doctrine ([14_LEGACY_UX_WORKFLOW_PARITY_MAP](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md) §6/§9):
do not invent UI — inspect legacy, preserve the workflow, mark every gap honestly.

> **Legacy source inspected** (read-only, outside this repo, not ported):
> `…/IDCaddie_Repo-main/frontend-v2/src/app/(authenticated)/contracts/create/page.tsx`,
> `…/contracts/[id]/page.tsx`, `…/contracts/page.tsx`,
> `…/frontend-v2/src/shared/fieldDefinitions.js` (`DEFAULT_CONTRACT_FIELDS`, `CONTRACT_FIELD_ORDER`),
> `…/webapp/functions/src/logging/contractOnWrite.js`. Legacy is Firebase/Firestore + a Next.js
> client app. **We port the workflow, never the backend/security model.**

## 1. Legacy CREATE workflow (`/contracts/create`)
Two tabs:
- **Upload PDF** (default) — upload a PDF → Firestore `files` doc + Storage + a `contracts` doc, then
  Vertex/Document-AI extraction auto-fills fields. **Out of scope for v3** (no file storage, no AI;
  `files` is default-deny — RISK-002). Not built.
- **Create Blank** — a manual form. Fields, in order: **Contract Name** (required; default placeholder
  `New Contract - <date>`), **Status** (`Draft`/`Executed`/`Cancelled`/`Expired`, default `Draft`),
  **Category** (`Technology`/`Professional Services`/`Leases`/`Facilities`/`Chargebacks`),
  **Monthly Cost** (`$` numeric), **Start Date**, **Expiry Date**, **Procurement Date**, **Renewal Date**,
  **Notes** (textarea). Button **Create Contract**; back-arrow → `/contracts`; on success
  `router.push('/contracts/<id>')`.

## 2. Legacy EDIT workflow (`/contracts/[id]`)
- Edit is **inline on the detail page** (toggle `editing`), **not** a separate route. Header shows
  **Edit** + **Delete**; editing flips fields to inputs with **Cancel** + **Save**.
- Save: `firestore.collection('contracts').doc(id).update({ fields, groups })`.
- Field set + labels come from `DEFAULT_CONTRACT_FIELDS` / `CONTRACT_FIELD_ORDER` (see §4).
- Also on the page (all **out of scope** for v3 PR #31): **Delete** (hard delete), **Group Access**
  (`groups[]` visibility), **App Allocator** (link apps with % cost allocation), **Linked Files**
  (upload/unlink PDFs), **AI Analysis** panel.

## 3. Legacy backend (NOT ported — anti-patterns)
- **Client-side role gate** as the authorization boundary: `canEdit = user.role === 'admin' || 'editor'`,
  `canCreateContract = …` decide whether write affordances/saves are allowed. v3 forbids this — **RLS is
  the boundary** ([02](./02_SECURITY_AND_RLS.md)); v3 may hide affordances for usability only.
- **Hard delete** (`doc.delete()`), file upload/storage, AI extraction, app link/unlink, group
  assignment — none ported (hard rules; RISK-002).
- **App-layer audit** (`contractOnWrite.js` Firestore `onWrite` logs create/update/**delete** from
  `lastModifiedBy` doc metadata). v3 does **not** port this — the `0010` DB `SECURITY DEFINER` trigger
  already audits accepted writes server-side; the app never writes audit rows.

## 4. Legacy field → v3 column mapping (the heart of parity honesty)
v3 `contracts` columns (`0001`): `contract_name`, `vendor_name`, `status`, `start_date`, `end_date`,
`renewal_date`, `notice_deadline`, `total_cost`, `currency`, `billing_frequency`, `owner_user_id`,
`procurement_org_id`, `paying_org_id`, `renewal_responsibility`. The PR #30 write helper
(`src/lib/data/contract-write.ts`) accepts the editable subset.

| Legacy field (`key` / label) | v3 column | In v3 form? |
|---|---|---|
| `name` / "Contract Name" \* | `contract_name` | ✅ required |
| `status` / "Status" (Draft/Executed/Cancelled/Expired) | `status` | ✅ same options, default `Draft` |
| `monthlyCost` / "Monthly Cost ($)" | `total_cost` (+ `currency`) | ⚠️ **Partial** — v3 has a single `total_cost`, **not** a monthly recurring cost; labeled "Total cost" (semantic difference, documented) |
| `startDate` / "Start Date" | `start_date` | ✅ |
| `expiryDate` / "Expiry Date" | `end_date` | ✅ (labeled "Expiry / end date") |
| `renewalDate` / "Renewal Notice Date" | `renewal_date` | ✅ (legacy key `renewalDate`; v3 also has a distinct `notice_deadline` not surfaced in this form) |
| `category` (Technology/Prof Services/Leases/Facilities/Chargebacks) | `category` (`0011`) | ✅ **added (PR #32)** — `<select>` of the legacy options |
| `procurementDate` / "Procurement Date" | `procurement_date` (`0011`) | ✅ **added (PR #32)** |
| `notes` / "Notes" | `notes` (`0011`) | ✅ **added (PR #32)** — textarea |
| `poNumber` / "PO Number" | `po_number` (`0011`) | ✅ **added (PR #32)** |
| `autoRenew` / "Auto Renew" (bool) | `auto_renew` (`0011`, NOT NULL default false) | ✅ **added (PR #32)** — checkbox |
| `monthToMonth` / "Month-to-Month" (bool) | `month_to_month` (`0011`, NOT NULL default false) | ✅ **added (PR #32)** — checkbox |
| `commodity_software` / `commodity_leases` (`select`; hidden via `showif … && false`) | — | ❌ **Not added** — hidden in legacy (not user-visible); deliberately out of scope ([0011] note) |
| `validated` / "Validated" (read-only) | — | ❌ **Not added** — legacy read-only / system-managed; not part of a create/edit form |
| `createdBy` / "Created By" (read-only) | — (v3: `created_at`) | ❌ not editable; v3 shows `created_at` on read |
| Upload-PDF tab → AI extraction | — | ❌ **Not built** (no files/AI; RISK-002) |

v3 columns surfaced in the form that the legacy form did **not** have (included so the form round-trips
v3's existing read detail page, [02 §8]/PR #19): `vendor_name` ("Vendor"), `currency`,
`renewal_responsibility`, `procurement_org_id` (the **write anchor**) + `paying_org_id` (a read signal,
never a write grant) via RLS-scoped org `<select>`s. v3's `notice_deadline` and `billing_frequency`
columns are **not** in this form (kept aligned to the task's field set; editable later if parity needs).

## 5. Parity verdict (PR #31 built the form; PR #32 closed the schema-backed field gaps)
**Still Partial, not Same — but closer.** v3 builds the create/edit form on `/contracts/new` +
`/contracts/[id]/edit`, posting to the PR #30 RLS-gated server actions (audit via `0010`).
- **PR #31** shipped name/status/cost/dates + vendor/currency/renewal-responsibility/org.
- **PR #32** added the safe, schema-backed legacy fields via migration `0011`: `category`,
  `procurement_date`, `notes`, `po_number`, `auto_renew`, `month_to_month` (§4 table above).

**Still NOT built** (so parity is **not** Same): legacy `commodity_*` (hidden in legacy via
`showif … && false` — not user-visible) and `validated` (legacy read-only / system-managed) are
deliberately omitted; the PDF-upload/AI-extraction tab, **delete**, groups, app-allocation, file
attachments, and **gantt** need a separate surface or table that does not exist (files/links — RISK-002);
the legacy list-page inline cell-edit + bulk-delete are also not built. Legacy stays the source of truth;
these gaps are tracked in [14](./14_LEGACY_UX_WORKFLOW_PARITY_MAP.md). **No parity claim of Same;
RISK-002 + RISK-016 open; OMC/Flywheel cutover + new paid-customer onboarding stay blocked.**
