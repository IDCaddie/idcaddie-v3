-- 0084_contract_entitlements.sql
--
-- Phase 10 — the PURCHASED side of the commercial graph.
--
-- THE GAP THIS CLOSES. v3 can say "there is a Slack contract worth $180,000" and, separately, "this Slack connector has
-- 3,011 accounts". It cannot say whether those two numbers agree, because nothing records WHAT WAS BOUGHT. `contracts`
-- holds a single `total_cost` — a commitment, not a quantity. There is no seat count, no unit price, no SKU, and no
-- foreign key from a contract to the canonical `vendors` / `app_products` rows that 0024 created. `contracts.vendor_name`
-- and `apps.vendor_name` are free text, so "Slack" the contract and "Slack" the connector are two unrelated strings.
--
-- A contract_entitlement is ONE PURCHASED LINE: this contract bought this much of this product, at this unit price, on
-- this cadence, for this term. It is the join that makes the commercial chain answerable end to end:
--
--     contract -> vendor -> product -> PURCHASED QUANTITY -> (declared measurement source) -> discovered evidence
--
-- FIVE CONCEPTS, NEVER COLLAPSED. The single most expensive mistake available here is to store one "seats" number and
-- let the product decide later what it meant. These are different facts with different sources and they stay apart:
--
--     purchased    what the contract says was bought.            THIS TABLE. Commercial paper.
--     assigned     who the identity provider grants access to.   directory_application_user_assignments (0059).
--     provisioned  who exists in the vendor's own system.        app_accounts where sync_status='current' (0076).
--     billable     who the vendor actually charges for.          NO SOURCE EXISTS. license_evaluations (0001) has never
--                                                                been written by anything; there is no billing feed.
--     active       who actually used it.                         NO SOURCE EXISTS. The `usage` capability (Phase 7B) is
--                                                                vocabulary only — no connector produces it.
--
-- This migration adds the FIRST of those five and NOTHING ELSE. It does not invent the other four, and it must never be
-- read as though a purchased quantity implies any of them. `app_accounts.account_status = 'active'` is the PROVIDER'S
-- lifecycle bucket (0076) — an account that exists and is not suspended. It is NOT usage, and a reader that treats it
-- as "recently active" is reporting a number the evidence does not support.
--
-- UNKNOWN IS NOT ZERO. Every commercial quantity here is NULLABLE on purpose. A contract whose seat count nobody has
-- entered has `purchased_quantity IS NULL` — "we have not been told", which is a different answer from "they bought 0",
-- and the reconciliation layer must render it differently. This is the same discipline as the capability model (Phase
-- 7B) and stale-aware counts (0074): a zero is a claim, and we only make claims we can evidence.
--
-- MEASUREMENT IS DECLARED, NEVER INFERRED. `measured_by_connection_id` names the connector whose discovered evidence
-- this purchased line is to be compared against. There is deliberately no name/domain matching: "Slack" the contract and
-- a connector with provider='slack' may be different workspaces, different regions, or two vendors sharing a word. A
-- comparison between a purchase and a discovery is a JUDGEMENT with an author, so it is stored as a declared fact —
-- exactly the reasoning behind connector supersession (0071) and application matches (0075).
--
-- A PRICE THAT CANNOT BE ANNUALIZED IS NOT A PRICE. `unit_amount` is CHECK-constrained to require both a currency and a
-- billing frequency. Without currency the number is meaningless; without cadence no annual figure can be derived from
-- it, and a savings estimate built on an assumed cadence is a fabricated number. The database refuses the half-fact
-- rather than letting a later engine guess.
--
-- MINIMUM QUANTITY IS A SAVINGS BRAKE, NOT DECORATION. `minimum_quantity` records a contracted floor. Reclaiming seats
-- down to that floor saves nothing, so an opportunity estimate that ignores it overstates savings on precisely the
-- contracts where a customer would check the maths. It is here in the first version because leaving it out makes the
-- first savings finding wrong, not merely incomplete.
--
-- PROVENANCE IS MANDATORY. `source` and `confidence` are NOT NULL. Every financial figure this product ever shows must
-- be able to answer "where did that come from?", and the default is the conservative one (manual entry, low confidence)
-- so an unattributed number can never masquerade as a verified one. `evidence_file_id` points at the uploaded document
-- the figure was read from, reusing the existing files model (0012-0016) rather than a new store.
--
-- AUTHORIZATION IS INHERITED, NOT REINVENTED. Read = you can read the parent contract (the 0006 subquery-RLS mechanism:
-- the EXISTS is itself filtered by the contracts SELECT policy, so tenant members and procurement/paying-org members get
-- exactly the visibility they already have). Write = the same two authorities that may write the contract itself
-- (0004: tenant editor+ OR manager of the contract's procurement org). No DELETE policy — 0004's hard-delete protection
-- covers financial evidence too.
--
-- AUDITED ON WRITE. Contract money is exactly the class of fact that needs an actor and a timestamp, so an accepted
-- INSERT/UPDATE appends to audit_logs through the 0010 SECURITY DEFINER trigger pattern. The allowlist records WHICH
-- entitlement changed and its quantity — never the price, per 0010's convention of keeping costs out of audit metadata.
--
-- WHAT THIS MIGRATION DOES NOT DO. It creates no entitlement rows, runs no matcher, adds no RPC, reads nothing, and
-- changes not one existing table, policy, or trigger. It does not touch connector authentication, OAuth, the connector
-- runner, the shared connector framework, or the Slack / Google / Okta implementations. Nothing in the product reads
-- this table yet.
--
-- Migration-safety: CREATE TABLE|INDEX|FUNCTION|TRIGGER|POLICY + GRANT only — additive; no teardown, no row purge, no
-- destructive ops. Staging only.

begin;

create table if not exists public.contract_entitlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  -- The paper this line came off. Deleting the contract deletes its lines: an entitlement with no contract is not
  -- evidence of anything.
  contract_id uuid not null references public.contracts (id) on delete cascade,

  -- ── WHAT was bought ────────────────────────────────────────────────────────────────────────────────────────────
  -- All three are optional and independent. A line can name a vendor before anyone has decided which canonical product
  -- it is; `on delete set null` means retiring a canonical row never destroys the commercial fact that a purchase
  -- happened. `app_id` is the operational `apps` record (the one `app_contracts` already links), kept alongside
  -- `app_product_id` because the two models answer different questions and 0075 established they stay separate.
  vendor_id uuid,
  app_product_id uuid,
  app_id uuid,

  -- The vendor's own name for the thing. Free text because SKUs are vendor-shaped and no catalog exists to validate
  -- against; recording the string is strictly better than discarding it.
  sku text,
  plan_name text,

  -- ── HOW MUCH was bought ────────────────────────────────────────────────────────────────────────────────────────
  -- NULL = not recorded. Never defaulted to 0 (see header).
  purchased_quantity integer,
  constraint contract_entitlements_purchased_quantity_chk check (purchased_quantity is null or purchased_quantity >= 0),

  -- The contracted floor. Seats reclaimed below this are still paid for, so a savings estimate must stop here.
  minimum_quantity integer,
  constraint contract_entitlements_minimum_quantity_chk check (minimum_quantity is null or minimum_quantity >= 0),
  constraint contract_entitlements_minimum_not_above_purchased_chk check (
    minimum_quantity is null or purchased_quantity is null or minimum_quantity <= purchased_quantity),

  -- What one of them is. Bounded so a reader never has to interpret free text to know whether "3200" is seats or
  -- gigabytes. 'unit' is the honest catch-all for a line nobody has classified.
  quantity_unit text not null default 'seat',
  constraint contract_entitlements_quantity_unit_chk check (quantity_unit in ('seat', 'license', 'user', 'credit', 'unit')),

  -- ── WHAT it costs ──────────────────────────────────────────────────────────────────────────────────────────────
  -- Four decimal places: per-seat prices are routinely quoted in cents-and-fractions and rounding them at storage time
  -- makes an annual total visibly wrong at scale.
  unit_amount numeric(14, 4),
  constraint contract_entitlements_unit_amount_chk check (unit_amount is null or unit_amount >= 0),
  currency text,
  billing_frequency text,
  constraint contract_entitlements_billing_frequency_chk check (
    billing_frequency is null or billing_frequency in ('monthly', 'quarterly', 'annual', 'multi_year', 'one_time')),
  -- A price with no currency, or none that can be put on an annual footing, is not a usable figure. Refuse it here
  -- rather than letting an engine assume USD/annual downstream.
  constraint contract_entitlements_priced_line_is_complete_chk check (
    unit_amount is null or (currency is not null and billing_frequency is not null)),

  -- ── WHEN it applies ────────────────────────────────────────────────────────────────────────────────────────────
  -- The LINE's term, which may be shorter than the contract's (a mid-term seat expansion co-terminates with the
  -- master). Renewal/notice stay on `contracts` — they are properties of the agreement, not of a line, and duplicating
  -- them here would create two answers to one question.
  term_start date,
  term_end date,
  constraint contract_entitlements_term_order_chk check (term_start is null or term_end is null or term_end >= term_start),

  -- ── WHICH discovered evidence measures it ──────────────────────────────────────────────────────────────────────
  -- Declared, never inferred. NULL = nobody has said which connector observes this product, so the purchased quantity
  -- stands alone and the reconciliation must report "not measured" rather than comparing it to something plausible.
  measured_by_connection_id uuid,

  -- ── PROVENANCE ─────────────────────────────────────────────────────────────────────────────────────────────────
  -- Required. The defaults are the conservative reading of an unattributed entry.
  source text not null default 'manual_entry',
  constraint contract_entitlements_source_chk check (
    source in ('contract_document', 'order_form', 'invoice', 'vendor_portal', 'manual_entry')),
  confidence text not null default 'low',
  constraint contract_entitlements_confidence_chk check (confidence in ('high', 'medium', 'low')),
  -- The uploaded document a figure was read from, when there is one (files, 0012-0016).
  evidence_file_id uuid,
  -- Free-text provenance for the human case ("order form p.3, line 2"). Never a secret, never a URL to a credential.
  evidence_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint contract_entitlements_id_tenant_key unique (id, tenant_id),

  -- Every reference must live in the SAME tenant as the line. Enforced by composite FK — a database guarantee that a
  -- trigger or an application filter could be made to skip. (0005's mechanism; MATCH SIMPLE skips NULLs.)
  constraint contract_entitlements_contract_same_tenant
    foreign key (contract_id, tenant_id) references public.contracts (id, tenant_id) on delete cascade,
  constraint contract_entitlements_vendor_same_tenant
    foreign key (vendor_id, tenant_id) references public.vendors (id, tenant_id) match simple on delete set null,
  constraint contract_entitlements_product_same_tenant
    foreign key (app_product_id, tenant_id) references public.app_products (id, tenant_id) match simple on delete set null,
  constraint contract_entitlements_app_same_tenant
    foreign key (app_id, tenant_id) references public.apps (id, tenant_id) match simple on delete set null,
  constraint contract_entitlements_connection_same_tenant
    foreign key (measured_by_connection_id, tenant_id) references public.connectors (id, tenant_id) match simple on delete set null,
  constraint contract_entitlements_evidence_file_same_tenant
    foreign key (evidence_file_id, tenant_id) references public.files (id, tenant_id) match simple on delete set null
);

comment on table public.contract_entitlements is
  'One purchased line of a contract: what product, how many, at what unit price, on what cadence, over what term. The PURCHASED concept only — never assigned, provisioned, billable, or active, which have separate sources (or none).';
comment on column public.contract_entitlements.purchased_quantity is
  'NULL means not recorded, which is NOT zero. A reconciliation must render the two differently.';
comment on column public.contract_entitlements.measured_by_connection_id is
  'The connector whose discovered evidence this line is compared against. Declared by an operator, never inferred from a name or domain.';
comment on column public.contract_entitlements.minimum_quantity is
  'Contracted floor. Reclaim below this is still paid for, so a savings estimate stops here.';

-- Reads are "the lines of this contract" and "the lines measured by this connector"; both are indexed.
create index if not exists contract_entitlements_contract_idx
  on public.contract_entitlements (tenant_id, contract_id);
create index if not exists contract_entitlements_connection_idx
  on public.contract_entitlements (tenant_id, measured_by_connection_id)
  where measured_by_connection_id is not null;
create index if not exists contract_entitlements_product_idx
  on public.contract_entitlements (tenant_id, app_product_id)
  where app_product_id is not null;

alter table public.contract_entitlements enable row level security;

-- ── READ: exactly the visibility of the parent contract ──────────────────────────────────────────────────────────
-- The EXISTS subquery is itself filtered by the contracts SELECT policies (tenant member, 0001; procurement/paying org
-- member, 0003) for the invoking user — the same subquery-RLS mechanism 0003 and 0006 already rely on. So this grants
-- no visibility beyond "you can already read the contract this line belongs to", and the same-tenant composite FK above
-- closes any cross-tenant path.
create policy "contract readers read contract_entitlements" on public.contract_entitlements
for select using (
  exists (
    select 1 from public.contracts c
     where c.id = contract_entitlements.contract_id
       and c.tenant_id = contract_entitlements.tenant_id
  )
);

-- ── WRITE: exactly the authorities that may write the contract (0004) ────────────────────────────────────────────
-- Tenant editor+, OR manager of the contract's procurement org. `paying_org` never grants write, here as there. The
-- org branch reads procurement_org_id through a subquery the reader is already entitled to (a procurement-org manager
-- can read their own contract under 0003), so it discloses nothing new.
create policy "contract writers insert contract_entitlements" on public.contract_entitlements
for insert with check (
  public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor'])
  or exists (
    select 1 from public.contracts c
     where c.id = contract_entitlements.contract_id
       and c.tenant_id = contract_entitlements.tenant_id
       and public.has_org_role_in_tenant(c.procurement_org_id, c.tenant_id, array['manager'])
  )
);

create policy "contract writers update contract_entitlements" on public.contract_entitlements
for update using (
  public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor'])
  or exists (
    select 1 from public.contracts c
     where c.id = contract_entitlements.contract_id
       and c.tenant_id = contract_entitlements.tenant_id
       and public.has_org_role_in_tenant(c.procurement_org_id, c.tenant_id, array['manager'])
  )
) with check (
  public.has_tenant_role(tenant_id, array['owner', 'admin', 'editor'])
  or exists (
    select 1 from public.contracts c
     where c.id = contract_entitlements.contract_id
       and c.tenant_id = contract_entitlements.tenant_id
       and public.has_org_role_in_tenant(c.procurement_org_id, c.tenant_id, array['manager'])
  )
);

-- No DELETE policy. Financial evidence is evidence (0004).

-- ── AUDIT ON WRITE (the 0010 pattern) ────────────────────────────────────────────────────────────────────────────
-- audit_logs has no `authenticated` INSERT policy, so the only safe writer is a SECURITY DEFINER trigger owned by the
-- migration owner. AFTER ROW, so a write RLS blocked (0 rows) is never audited. auth.uid() still resolves to the
-- CALLER under SECURITY DEFINER (it reads the request JWT, not the executing role).
create or replace function public.audit_contract_entitlement_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Curated allowlist. Quantity is recorded because "who changed the seat count, and when" is the audit question this
  -- table exists to answer. Price is deliberately excluded, matching 0010's rule that costs stay out of audit metadata.
  insert into public.audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, after_json)
  values (
    new.tenant_id,
    auth.uid(),
    case when tg_op = 'INSERT' then 'contract_entitlement.created' else 'contract_entitlement.updated' end,
    'contract_entitlement',
    new.id,
    jsonb_build_object(
      'contract_entitlement_id', new.id,
      'contract_id', new.contract_id,
      'operation', lower(tg_op),
      'purchased_quantity', new.purchased_quantity,
      'quantity_unit', new.quantity_unit,
      'source', new.source,
      'confidence', new.confidence
    )
  );
  return null;  -- AFTER ROW: return value ignored
end;
$$;

drop trigger if exists contract_entitlements_audit_on_write on public.contract_entitlements;
create trigger contract_entitlements_audit_on_write
  after insert or update on public.contract_entitlements
  for each row execute function public.audit_contract_entitlement_write();

-- `updated_at` is maintained by the write path (the DAL sets it), consistent with `contracts` — no trigger, so there
-- is one convention for the whole commercial model rather than two.

-- Explicit table privilege, for the reason 0015 records: a policy permits, it does not grant, and the harness-level
-- `grant ... on all tables` is not part of this migration chain. DELETE is withheld — no DELETE policy exists and no
-- privilege should imply one.
grant select, insert, update on public.contract_entitlements to authenticated;

commit;
