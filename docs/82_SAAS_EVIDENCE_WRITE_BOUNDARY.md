# 82 — The canonical SaaS evidence write boundary

Phase 8D. Migration **0077** plus the runner-side adapters that use it. This is the path a Slack (or any SaaS) sweep takes
from a provider response to a row a customer can see, and the rules that decide when it is allowed to.

Migration 0076 (doc [81](81_SLACK_CONNECTOR_STATE.md)) built the destination tables. Nothing could write to them. 0077 is
the door.

---

## 1. The shape of the path

```
provider JSON
  │  item schema (fails closed on a changed shape)
  ▼
executor fact                     one flat object: envelope + mapped payload
  │  toFactRows()                 envelope → columns, payload → fact_json
  ▼
runner_insert_discovery_fact      per-fact-type KEY allowlist + forbidden-key scan
  ▼
discovery_facts                   staging. Nothing customer-facing reads this.
  │  runner_promote_saas_app_*    ← per-resource completeness gate
  ▼
app_accounts / app_account_groups canonical evidence. sync_status = 'current'.
  │  runner_mark_absent_..._stale ← completeness + latest-run + lock + circuit breaker
  ▼
sync_status = 'stale'             retained, excluded from current counts, audited
```

Every arrow that writes is a `SECURITY DEFINER` function with a pinned `search_path`, executable by `connector_runner`
and by no one else. The runner holds **no** table grant on any of these tables, so the gates cannot be walked around —
not by a bug in the runner, and not by anyone holding the runner's credentials.

---

## 2. Per-resource completeness — the reason 0077 has its own table

The Okta path records completeness in `connector_run_discovery`, which is `PRIMARY KEY (run_id)`: **one row per run, no
resource discriminator**. That was correct when a run read one resource.

A Slack sweep reads two. If `usergroups.list` completes and `users.list` dies halfway, a single shared row says
"complete" — and the account staler, reading that row, would retire every account the user sweep never reached. A
partial read would look exactly like a workspace that emptied out.

So `connector_run_resource_discovery` is keyed `(run_id, resource)`, and each promoter and staler reads **its own**
resource's row. `resource` is the emitted **fact type** (`app_user_account`, `group`), not an endpoint id — the question
being asked is "were accounts fully read", and two endpoints could legitimately answer for the same resource.

The proven Okta gate is untouched. Test **W4** is the whole argument in executable form.

A resource is eligible only when all four hold:

| field | required | why |
|---|---|---|
| `completeness` | `true` | pagination ran to a null cursor |
| `records_rejected` | `0` | a rejected record means the read is not a faithful picture |
| `termination_reason` | `'last_page'` | a page/item/time budget cap is not an ending |
| `review_required` | `false` | a prior circuit-breaker trip flagged this run |

The executor makes the first one honest: `max_pages`, budget exhaustion and cursor cycles all return **failure**, so
there is no silent truncation that could ever be recorded as complete.

---

## 3. Promotion

`runner_promote_saas_app_accounts(run_id, tenant_id)` and `..._app_groups`:

- **Provider is pinned to the connector**, never read from the fact. A fact claiming to be Okta cannot retarget a row on
  a Slack connector.
- Reads `discovery_facts` by named field only. There is no writer that accepts arbitrary JSON, so there is nothing to
  smuggle a raw payload through.
- `distinct on (external_id) … order by observed_at desc` — a replayed page cannot double-insert.
- Upsert on `(tenant_id, connection_id, provider, external_id)`; `first_seen_at` is preserved.
- Always sets `sync_status = 'current'` **and** `stale_since = null`. The 0070 invariant, applied from the start rather
  than retrofitted.

### The bounded vocabulary is derived in exactly one place

The fact carries what the provider **said**; the promote RPC decides what it **means**:

| fact field | shape | who emits it |
|---|---|---|
| `is_bot`, `is_deleted`, `is_admin` | boolean | a declarative `field_map` (Slack) |
| `status` | string | a provider normalizer (Entra: `active`/`disabled`) |

→ `account_kind ∈ {human, bot, service, unknown}`, `account_status ∈ {active, inactive, deleted, unknown}`.

A provider that never reported the flag yields **`unknown`**, never a defaulted `human` or `active`. A misclassified bot
is a bot in an access review, and an invented `active` is an account someone will fail to revoke.

---

## 4. Stale marking

Same safety model as the Okta staler, with the per-resource gate substituted for the shared one:

1. eligibility for **`app_user_account` specifically** (§2)
2. **latest-run guard** — a superseded sweep would treat everything a newer run found as absent
3. **connector lock** (`select … for update`) — serializes promote/stale, closing the TOCTOU window
4. **first-run rule** — nothing was seen earlier, so nothing can be absent
5. **circuit breaker** — `> 30%` of current rows, or `> 100` rows, marks the run `review_required` and stales nothing

A refusal is a normal outcome, returned as data (`eligible`, `superseded`, `circuitBreakerTriggered`), not an exception.
The run succeeded; the evidence simply was not good enough to retire anything.

**Nothing is ever deleted.** A stale row is retained, excluded from `current` counts, and still counted in
`totalEvidence` — the contract in doc 79 / migration 0074.

### Audit

`audit_saas_stale_transition()` fires on `app_accounts` and `app_account_groups` **only on a transition into `stale`**,
so a status-preserving replay writes no second event (test W5). The event carries `reason_code`, the connector, the run
and the object id — no display name, no email, no provider payload, no exception text.

---

## 5. The normalized fact contract

`discovery_facts` stores the envelope in **columns** (`source_type`, `source_provider`, `signal_id`, `observed_at`,
`confidence`, …) and the payload in `fact_json`. The executor emits one *flat* object with both spread together, so the
runner splits it (`src/connector-sync/saas-fact-rows.ts`) before writing.

Until 0077 there was no key allowlist for `app_user_account` or `group` — they were the only two allowlisted fact types
with no promoter, so nothing read them. Both live paths were passing the whole flat object as `fact_json`, duplicating
the envelope inside the payload. 0077 rejects that. An un-named key in `fact_json` is an un-reviewed key, whether it came
from Slack or from our own envelope.

The allowlist is **narrower than the fact schema on purpose**: `app_id_hint`, `group_type`, `role_hint`,
`source_user_id` and `last_activity_at` are valid facts with nowhere to land in 0076. Emitting one fails loudly rather
than being dropped — a dropped key is indistinguishable from a key that was never emitted.

The splitter refuses rather than filters, for the same reason.

---

## 6. Adding another provider's fact type

1. Add the field to the fact schema in `src/lib/server/connector-vault/discovery-facts.ts` — **strict**, so a shape
   change fails closed. Prefer a boolean observation over a pre-bucketed string: a declarative `field_map` can carry a
   boolean, and a bucketed string needs provider-specific normalizer code.
2. Re-vendor into the runner and bump the `VENDOR.lock` blob SHA + `sourceSha` (a reviewed change, pinned to a **merge
   commit** on v3 `main`).
3. Add the key to 0077's `runner_insert_discovery_fact` allowlist **and** to `PAYLOAD_KEYS` in `saas-fact-rows.ts` — the
   two are kept in lockstep, and the SQL suite is the backstop.
4. Map it to a bounded canonical value **inside the promote RPC**. Do not add a second place that decides what
   `account_kind` means.
5. Add the manifest `field_map` entry and the item-schema type, so a changed provider shape fails closed instead of
   mapping a non-boolean into the fact.
6. Declare the capability in `src/lib/canonical/capabilities.ts` (doc 79). `planned` renders an explanation; a missing
   entry renders a zero.

---

## 7. What Phase 8D deliberately did not do

- **The customer OAuth callback is untouched.** It still calls `handleSyntheticSlackOAuthCallback`. Replacing it crosses
  the client-secret decrypt boundary in the request path and needs its own GO — see doc 81.
- No Slack contact, no ECS task, no scheduling, no production.
- No Slack-specific tables. Everything here is provider-agnostic; Slack is the first caller, not the subject.
- Nothing is written into `identity_accounts`. Slack is not an identity provider, and a SaaS account is not a person
  (test W1). Matching stays an explicit, confidence-bearing judgement in `app_account_identity_matches`.

### Sequencing note

The write boundary is complete and tested ahead of the callback that will feed it. A live sweep therefore still needs
(a) the real OAuth callback wired, and (b) a token that Slack still honours — the vault's three `oauth_access` rows date
from 2026-07-05 and their validity at Slack is unverified.

---

## 8. Verification

- `supabase/tests/saas_evidence_write_boundary_test.sql` — W0–W12, run by `scripts/test-rls.sh`.
- **Mutation-tested**: 12 deliberate defects (broadened grant, direct table write, dropped tenant/provider scope,
  un-cleared `stale_since`, stale-after-incomplete, cross-resource completeness, removed fact-type allowlist, removed
  key allowlist, an `identity_accounts` write, a removed audit trigger). All 12 are caught.
  - Two of them were caught only *after* tightening a test: `assert raised` passed even with the tenant gate deleted,
    because two further gates also refuse cross-tenant calls. W2 now asserts **which** gate refused. A test that passes
    for the wrong reason is worse than no test.
- `test/connector-sync/saas-fact-rows.test.ts` — the envelope/payload split, batching, and the writer's ordering.

**Harness trap, now hit four times:** `scripts/test-rls.sh` re-broadens every table after migrations to mirror hosted
Supabase defaults, which masks migration revokes. A new locked-down table must be re-asserted there in lockstep —
`connector_run_resource_discovery` is, next to the 0076 block.
