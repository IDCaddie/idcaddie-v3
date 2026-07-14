# Connector customer-pilot authorization packet (TEMPLATE)

**Copy this file per customer pilot and fill EVERY field with a sanitized opaque reference.** This is the single required input for a
first customer pilot (P5E15). It is **not** approval by itself — a filled packet is only *complete*; approval is a separate operator
act. Until every field below is present and verified, the pilot stays **BLOCKED — MISSING REQUIRED CUSTOMER EVIDENCE**. Staging only;
`certificationOnly` unchanged; RISK-007 OPEN; Phase C BLOCKED. See
[`CONNECTOR_FIRST_CUSTOMER_PILOT_AUTHORIZATION.md`](../CONNECTOR_FIRST_CUSTOMER_PILOT_AUTHORIZATION.md).

> **Sanitization rule (hard):** every value is an OPAQUE reference to an approved record kept OUTSIDE this repo — a ticket id, an
> agreement hash, an internal short code. **Never** write a customer name, domain, employee name, email, UPN, raw tenant/connector/
> client id, secret value, token, full ARN, DB URL, Graph payload, or any production identifier into this packet. A value that
> matches a secret/PEM/URL/email shape is rejected by `connector_pilot_ref_is_sensitive` (migration 0047) at record-creation time.

## Customer identity

| Field | Value | State |
|---|---|---|
| `internal_customer_ref` | `<blank>` | NOT PROVIDED |
| `staging_tenant_ref` | `<blank>` | NOT PROVIDED |
| `staging_connector_ref` | `<blank>` | NOT PROVIDED |
| `customer_entra_tenant_ref` | `<blank>` | NOT PROVIDED |
| `customer_account_ref` | `<blank>` | NOT PROVIDED |
| `non_synthetic_confirmation` (explicit: NOT the S1/S2 synthetic tenant or connector) | `<blank>` | NOT PROVIDED |
| `provider` | `microsoft_entra` | fixed |
| `environment` | `staging` | fixed |

## Consent

| Field | Value | State |
|---|---|---|
| `evidence_ref` (opaque pointer to the approved consent record) | `<blank>` | NOT PROVIDED |
| `consent_version` | `<blank>` | NOT PROVIDED |
| `consent_scope` | `<blank>` | NOT PROVIDED |
| `processing_purpose` | `<blank>` | NOT PROVIDED |
| `approved_graph_permissions` (exact application permission set) | `<blank>` | NOT PROVIDED |
| `consented_by_ref` | `<blank>` | NOT PROVIDED |
| `consented_at` | `<blank>` | NOT PROVIDED |
| `consent_expires_at` | `<blank>` | NOT PROVIDED |
| `withdrawal_method` | `<blank>` | NOT PROVIDED |
| `retention_acknowledgement` | `<blank>` | NOT PROVIDED |
| `deletion_acknowledgement` | `<blank>` | NOT PROVIDED |
| `incident_contact_acknowledgement` | `<blank>` | NOT PROVIDED |

## Ownership

| Field | Value | State |
|---|---|---|
| `support_owner_ref` | `<blank>` | NOT PROVIDED |
| `incident_owner_ref` | `<blank>` | NOT PROVIDED |
| `rollback_authority_ref` | `<blank>` | NOT PROVIDED |
| `customer_contact_ref` | `<blank>` | NOT PROVIDED |
| `approving_operator_ref` | `<blank>` | NOT PROVIDED |
| `approval_reason_ref` | `<blank>` | NOT PROVIDED |

## Credential metadata (NO secret value is read in this phase)

| Field | Value | State |
|---|---|---|
| `credential_reference_ref` | `<blank>` | NOT PROVIDED |
| `credential_version` | `<blank>` | NOT PROVIDED |
| `secret_expires_at` | `<blank>` | NOT PROVIDED |
| `customer_specific_confirmation` | `<blank>` | NOT PROVIDED |
| `cross_tenant_reuse_check` (confirmed NOT reused by any other tenant) | `<blank>` | NOT PROVIDED |
| `non_synthetic_credential_confirmation` | `<blank>` | NOT PROVIDED |

## Limits (fixed for the first authorization — do not raise)

| Field | Value |
|---|---|
| `maximum_runs` | `1` |
| `maximum_concurrent_runs` | `1` |
| `manual_only` | `true` |
| `schedule_allowed` | `false` |
| `maximum_graph_pages` | `5` |
| `maximum_records` | `100` |
| `maximum_runtime_minutes` | `10` |
| `maximum_token_requests` | `1` |
| `maximum_graph_retries` | `2` |
| `discovery_only` | `true` |
| `promotion_disabled` | `true` |

## Window

| Field | Value | State |
|---|---|---|
| `approval_starts_at` | `<blank>` | NOT PROVIDED |
| `approval_expires_at` | `<blank>` | NOT PROVIDED |
| `first_run_earliest_at` | `<blank>` | NOT PROVIDED |
| `first_run_latest_at` | `<blank>` | NOT PROVIDED |
| `operator_available_ref` | `<blank>` | NOT PROVIDED |
| `customer_contact_available_ref` | `<blank>` | NOT PROVIDED |

## Completeness rules (all enforced before the pilot may be created or approved)

1. **Every required field must be present.** A single `<blank>` / NOT PROVIDED field blocks the whole packet.
2. **No placeholder may be treated as approval.** A filled-looking value that is a placeholder/example is not approval.
3. **No fabricated values.** If a fact is unknown, it stays NOT PROVIDED — never invented, never inferred.
4. **Expired consent blocks** — `consent_expires_at` must be in the future at every check (packet, approval, and each run).
5. **Expired secret blocks** — `secret_expires_at` must be in the future; a malformed/absent value fails closed.
6. **Missing owner blocks** — `support_owner_ref` and `incident_owner_ref` are both mandatory before approval.
7. **Unknown permission blocks** — `approved_graph_permissions` must be the exact current read-only user-discovery scope; anything
   unexpected (extra permission, delegated substitute, drift) blocks.
8. **Missing customer availability blocks** — `operator_available_ref` and `customer_contact_available_ref` for the run window are
   mandatory.
9. **Any customer/connector/credential mismatch blocks** — the tenant, connector, provider, credential reference, and credential
   version must all bind to the SAME customer (composite same-tenant FK + exact-match gate, migration 0047); any cross-binding,
   synthetic reuse, or cross-tenant credential reuse blocks.

**A complete, verified packet does not enable anything.** It only makes a disabled pilot record *creatable* and a first run
*authorizable under a separate fresh GO*. Never PASS at S3 — the only statuses are BLOCKED or READY FOR FIRST MANUAL RUN.
