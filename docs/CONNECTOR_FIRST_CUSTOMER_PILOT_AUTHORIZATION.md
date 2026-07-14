# Connector first customer-pilot authorization (P5E15 · Gate S3)

**Canonical source for: how ONE real customer pilot is authorized before any first run.** Companion to the
[customer-pilot model](./CONNECTOR_CUSTOMER_PILOT_MODEL.md), [consent model](./CONNECTOR_CUSTOMER_CONSENT_MODEL.md), and
[retention & deletion](./CONNECTOR_PILOT_RETENTION_AND_DELETION.md). The reusable input is
[`templates/CONNECTOR_CUSTOMER_PILOT_AUTHORIZATION_PACKET.md`](./templates/CONNECTOR_CUSTOMER_PILOT_AUTHORIZATION_PACKET.md); the
runner-side run plan + abort matrix live in idcaddie-connector-runner `docs/MICROSOFT_ENTRA_FIRST_CUSTOMER_PILOT_PLAN.md` +
`…ABORT_MATRIX.md`. Staging only; `certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. **This document authorizes nothing —
it defines HOW a first pilot becomes authorizable.**

## Current status

**S3 PILOT AUTHORIZATION: BLOCKED — MISSING REQUIRED CUSTOMER EVIDENCE.** No customer is identified; no authorization packet exists.
This framework is the reusable machinery a real packet is later inserted into without redesign. Enabling or running a pilot is a
separate, fresh explicit GO. Never PASS at S3 — the only statuses are **BLOCKED** or **READY FOR FIRST MANUAL RUN**.

## Authorization flow (each stage gates the next; fail-closed)

1. **Packet** — copy the template, fill EVERY field with a sanitized opaque reference. A single missing field ⇒ BLOCKED. No
   fabricated values; no placeholder treated as approval.
2. **Consent + legal-scope review** — verify the customer explicitly agreed to: staging-only processing; read-only Entra discovery;
   the exact approved Graph permission; no canonical promotion; no automated scheduling; max one initial run; max 100 records; a
   defined retention period; the deletion-request + incident-notification processes; immediate consent withdrawal; immediate pilot
   pause; no production use. Consent evidence is an OPAQUE reference — never a signed document or PII. Unclear / expired / overly
   broad / missing consent ⇒ do not create the pilot, do not touch credentials, keep S3 BLOCKED.
3. **Read-only binding preflight (metadata only)** — prove, WITHOUT reading a secret / acquiring a token / calling Graph / running
   the connector: the customer tenant exists in staging; the connector exists, belongs to that tenant, is `microsoft_entra`, and is
   in the eligible state; the credential reference exists and belongs to the same tenant+connector; the credential version matches
   the packet; secret metadata shows an acceptable expiry; the customer account reference is opaque + non-sensitive; no second
   customer pilot is active; no credential reference is reused across tenants; no synthetic connector/credential is involved; no
   production target exists.
4. **Permission preflight (approved metadata only)** — the exact application permission matches the current read-only
   user-discovery scope; admin consent is represented in metadata; no unexpected permission; no delegated substitute; tenant binding
   matches; token audience expectation is Microsoft Graph; the expected role set contains ONLY the approved role; drift and consent
   loss both fail closed. **No live token is acquired or inspected** — synthetic claims / metadata fixtures only.
5. **Disabled record creation (only if complete)** — see below. A single assumption or fabricated value ⇒ do not create it.
6. **Plans** — the kill-switch plan, the first-run operator plan, and the abort matrix are prepared (runner docs) but nothing is
   enabled.
7. **Decision** — BLOCKED or READY FOR FIRST MANUAL RUN. A first run then needs its own fresh GO.

## Disabled pilot record — required initial state (P5E15 Phase 5, only under a real complete packet)

`pilot_status = approved` (or `paused`, per the lifecycle) · `enabled = false` · `manual_only = true` · `schedule_allowed = false` ·
`discovery_only = true` · `promotion_disabled = true` · `maximum_runs = 1` · `maximum_records_per_run = 100` · customer kill switches
present but **disabled** · no runnable authorization · no execution slot · no held lock · no incident · `approval_expires_at` set ·
`consent_expires_at` set · `support_owner` + `incident_owner` present. **Do not transition to `enabled`. Do not create a runnable
authorization. Do not activate any kill switch.** All enforced by migration 0047 (deny-all + CHECK-forced invariants + the composite
same-tenant FK). **No such record exists yet** (no customer).

## Readiness checklist (three states: VERIFIED / BLOCKED / NOT PROVIDED)

Every customer-specific item **defaults to NOT PROVIDED** until a real packet is supplied and verified. It may only become VERIFIED
from an approved opaque reference — never from an assumption.

| # | Authorization item | State |
|---|---|---|
| 1 | Exact customer tenant identified (non-synthetic) | NOT PROVIDED |
| 2 | Staged connector belongs to that customer | NOT PROVIDED |
| 3 | Credential reference belongs to that tenant + connector | NOT PROVIDED |
| 4 | Credential version matches the packet | NOT PROVIDED |
| 5 | Secret expiry acceptable (metadata only) | NOT PROVIDED |
| 6 | Customer account reference opaque + non-sensitive | NOT PROVIDED |
| 7 | Explicit consent evidence present + active + not overly broad | NOT PROVIDED |
| 8 | Consent scope + purpose + version recorded | NOT PROVIDED |
| 9 | Exact approved Graph permission set known | NOT PROVIDED |
| 10 | Retention + deletion + incident-contact acknowledgements | NOT PROVIDED |
| 11 | Support owner assigned | NOT PROVIDED |
| 12 | Incident owner assigned | NOT PROVIDED |
| 13 | Rollback authority assigned | NOT PROVIDED |
| 14 | Customer contact assigned | NOT PROVIDED |
| 15 | Approving operator + approval reason | NOT PROVIDED |
| 16 | Approval window (start/expiry) valid | NOT PROVIDED |
| 17 | First-run window (earliest/latest) valid | NOT PROVIDED |
| 18 | Operator availability during the run | NOT PROVIDED |
| 19 | Customer-contact availability during the run | NOT PROVIDED |
| 20 | Limits pinned (1 run, manual, no schedule, 5 pages, 100 records, 10 min, 1 token, 2 retries, discovery-only, no promotion) | VERIFIED (fixed by the packet + 0047 CHECKs) |
| 21 | No second active customer pilot | VERIFIED (0047 one-enabled + one-active indexes; none exists) |
| 22 | Staging-only; no production target in any planned command | VERIFIED (staging `ycdpz…`; production hard-blocked) |
| 23 | Entra certificationOnly · RISK-007 OPEN · Phase C BLOCKED | VERIFIED |

**Result: BLOCKED** — items 1–19 are NOT PROVIDED (no customer). When a real packet fills them and every one is VERIFIED (and the
runner dry-run + hosted dormancy are green under a fresh GO), the status may move to **READY FOR FIRST MANUAL RUN** (never PASS).

## What this does NOT do

No pilot record created; no customer data used; no secret read; no token; no Graph; no ECS; no schedule; no promotion; no production.
The first customer run requires a separate explicit GO.
