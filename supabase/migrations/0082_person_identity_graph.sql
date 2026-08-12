-- 0082 — the PERSON layer: the provider-independent node every cross-source governance finding hangs off.
--
-- WHY THIS EXISTS. The estate already stores two parallel PROVIDER-ACCOUNT models — `identity_accounts` (the IdP/directory
-- side, 0053) and `app_accounts` (the SaaS side, 0076) — and 0076/0078 link a SaaS account to ONE IdP identity pairwise.
-- That pairwise link cannot answer the questions the governance engine needs to ask, because it has no node for the human:
--   * two IdP accounts for one person (two Okta orgs — the estate this product runs against HAS them, see 0071) are unrelated;
--   * two SaaS accounts with NO IdP account between them (Slack + Google in a tenant with no directory) have no path at all;
--   * "this person left and still holds a license" has no subject to be about.
-- So this migration adds the node and the EVIDENCE-BEARING edge to it. It does NOT add a second account model.
--
-- WHY A TABLE AND NOT `identity_accounts.person_id`. That nullable FK has shipped since 0001 and nothing has ever written it.
-- It carries no method, no confidence, no author and no way to say "proposed". A person link is a JUDGEMENT — the same
-- reasoning that made 0075 `application_matches` and 0076 `app_account_identity_matches` tables rather than joins:
-- DECLARE, NEVER INFER. `identity_accounts.person_id` is deliberately left untouched and unwritten; this table is
-- authoritative, and two writers for one fact is how you get two answers.
--
-- WHAT IT REFUSES TO DO, each because guessing here attributes one human's access to another:
--   * No display-name or fuzzy-name matching. 0076 excluded the method from its CHECK on purpose; this honours it.
--   * No domain-only matching. Sharing a domain is a colleague, not a person.
--   * No auto-acceptance. Every proposal lands `proposed` and a human decides, exactly as 0078 does.
--   * Two different addresses are two persons until a human says otherwise. An alias is evidence we do not have —
--     unless a human already accepted the account match that proves it (the `accepted_account_match` method below).
-- Nothing here computes a finding, and nothing here reads or writes a connector.

-- ══ A. THE MISSING PARENT UNIQUE ═══════════════════════════════════════════════════════════════════════════════════════
-- 0056 gave identity_accounts a FULL unique on (id, tenant_id, connection_id, provider); the same-tenant FK pattern (0005)
-- needs the 2-tuple. Additive and safe for the same reason 0056 gave: `id` is the PK, so (id, tenant_id) is already unique.
alter table public.identity_accounts drop constraint if exists identity_accounts_id_tenant_key;
alter table public.identity_accounts add constraint identity_accounts_id_tenant_key unique (id, tenant_id);

-- ══ B. THE EDGE: provider account -> person ════════════════════════════════════════════════════════════════════════════
create table if not exists public.person_account_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  person_id uuid not null,

  -- EXACTLY ONE endpoint. The two account models are separate tables, so the endpoint is a real FK to one of them rather
  -- than a polymorphic (kind, id) pair — a polymorphic reference cannot carry the same-tenant composite FK that keeps a
  -- link from ever pointing across tenants, and that guarantee is worth more than the column.
  identity_account_id uuid,
  app_account_id uuid,
  constraint pal_one_endpoint_chk check (num_nonnulls(identity_account_id, app_account_id) = 1),

  -- The evidence that produced this link. `normalized_email` is the only automated address method; `accepted_account_match`
  -- is transitive from a human-accepted 0076 match (the ONLY way two DIFFERENT addresses become one person); `manual` is a
  -- human asserting it directly.
  method text not null,
  constraint pal_method_chk check (method in ('manual', 'normalized_email', 'accepted_account_match')),
  confidence text not null,
  constraint pal_confidence_chk check (confidence in ('high', 'medium', 'low')),
  status text not null default 'proposed',
  constraint pal_status_chk check (status in ('proposed', 'accepted', 'rejected')),
  rationale text,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  constraint pal_decided_chk check (
    (status = 'proposed' and decided_at is null) or (status in ('accepted', 'rejected') and decided_at is not null)),
  created_at timestamptz not null default now(),

  -- Same-tenant integrity on all three endpoints (the 0005 pattern). A NULL account column passes MATCH SIMPLE, which is
  -- exactly what the one-endpoint CHECK above intends.
  constraint pal_person_fk foreign key (person_id, tenant_id)
    references public.people (id, tenant_id) on delete cascade,
  constraint pal_identity_fk foreign key (identity_account_id, tenant_id)
    references public.identity_accounts (id, tenant_id) on delete cascade,
  constraint pal_app_account_fk foreign key (app_account_id, tenant_id)
    references public.app_accounts (id, tenant_id) on delete cascade
);

-- ONE accepted person per provider account. An account belongs to at most one human; a human holds many accounts, so the
-- person side is deliberately NOT constrained (that is the whole point of the node).
create unique index if not exists pal_one_accepted_identity_idx
  on public.person_account_links (tenant_id, identity_account_id)
  where status = 'accepted' and identity_account_id is not null;
create unique index if not exists pal_one_accepted_app_account_idx
  on public.person_account_links (tenant_id, app_account_id)
  where status = 'accepted' and app_account_id is not null;

-- One row per (person, account) pair in either direction — the ON CONFLICT targets that make re-proposal idempotent and
-- make "a human already rejected this pair" permanent.
create unique index if not exists pal_person_identity_pair_idx
  on public.person_account_links (tenant_id, person_id, identity_account_id) where identity_account_id is not null;
create unique index if not exists pal_person_app_account_pair_idx
  on public.person_account_links (tenant_id, person_id, app_account_id) where app_account_id is not null;

create index if not exists pal_person_idx on public.person_account_links (tenant_id, person_id);

-- RLS on, NO policy: every read goes through a product RPC or not at all — the posture of every directory_* and
-- app_account_* table. The connector runner has no business here; a link is a human judgement, not connector evidence.
alter table public.person_account_links enable row level security;
revoke all on public.person_account_links from anon, authenticated, connector_runner;

-- ══ C. PROPOSE ═════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Deterministic. Given the same rows it proposes the same links, and it NEVER accepts one.
--
-- Two passes, in this order:
--   1. ADDRESS — every CURRENT account carrying a normalized_email is proposed against the person for that address,
--      creating the person if this tenant has none. Sharing a verified address is the strongest automated evidence there is.
--   2. TRANSITIVE — a SaaS account whose 0076 match to an IdP identity a human ACCEPTED belongs to that identity's person,
--      even when the two addresses differ. This is the only path by which an alias becomes one person, and it rests on a
--      human decision rather than a string.
--
-- ponytail: bots are excluded on the SaaS side via account_kind, but `identity_accounts` has no kind column (0053 never
-- added one), so an IdP service account with an address is proposed like any other. The human decision gate is what
-- catches it; add a kind column to identity_accounts if that gate proves too noisy in practice.
create or replace function public.product_propose_person_links(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare
  v_people_created integer := 0;
  v_identity_proposed integer := 0;
  v_app_proposed integer := 0;
  v_transitive_proposed integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;

  -- `people` carries no unique on (tenant_id, primary_email) — legacy rows predate this path and may already duplicate an
  -- address, so adding one could fail on real data. Serialize per tenant instead: two concurrent proposals cannot both
  -- decide a person is missing and create it twice.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 0));

  -- ── 1. Every distinct address in the estate that has no person yet ──────────────────────────────────────────────────
  with addr as (
    select i.normalized_email as email
      from public.identity_accounts i
     where i.tenant_id = p_tenant_id and i.sync_status = 'current' and i.normalized_email is not null
    union
    select a.normalized_email
      from public.app_accounts a
     where a.tenant_id = p_tenant_id and a.sync_status = 'current'
       and a.account_kind = 'human' and a.normalized_email is not null
  ), created as (
    insert into public.people (tenant_id, primary_email, source)
    select p_tenant_id, addr.email, 'identity_graph'
      from addr
     where not exists (
       select 1 from public.people p
        where p.tenant_id = p_tenant_id and lower(p.primary_email) = addr.email)
    returning 1)
  select count(*) into v_people_created from created;

  -- ── 2. ADDRESS pass — link each current account to the person for its address ───────────────────────────────────────
  with ins as (
    insert into public.person_account_links
      (tenant_id, person_id, identity_account_id, method, confidence, status, rationale)
    select p_tenant_id, p.id, i.id, 'normalized_email', 'high', 'proposed',
           'This directory account''s email address is this person''s address.'
      from public.identity_accounts i
      join public.people p
        on p.tenant_id = p_tenant_id and lower(p.primary_email) = i.normalized_email
     where i.tenant_id = p_tenant_id and i.sync_status = 'current' and i.normalized_email is not null
    on conflict (tenant_id, person_id, identity_account_id) where identity_account_id is not null do nothing
    returning 1)
  select count(*) into v_identity_proposed from ins;

  with ins as (
    insert into public.person_account_links
      (tenant_id, person_id, app_account_id, method, confidence, status, rationale)
    select p_tenant_id, p.id, a.id, 'normalized_email', 'high', 'proposed',
           'This application account''s email address is this person''s address.'
      from public.app_accounts a
      join public.people p
        on p.tenant_id = p_tenant_id and lower(p.primary_email) = a.normalized_email
     where a.tenant_id = p_tenant_id and a.sync_status = 'current'
       and a.account_kind = 'human' and a.normalized_email is not null
    on conflict (tenant_id, person_id, app_account_id) where app_account_id is not null do nothing
    returning 1)
  select count(*) into v_app_proposed from ins;

  -- ── 3. TRANSITIVE pass — a human-accepted account match carries its person across a differing address ───────────────
  with ins as (
    insert into public.person_account_links
      (tenant_id, person_id, app_account_id, method, confidence, status, rationale)
    select p_tenant_id, l.person_id, m.app_account_id, 'accepted_account_match', 'high', 'proposed',
           'A reviewer accepted this application account as belonging to this person''s directory identity.'
      from public.app_account_identity_matches m
      join public.person_account_links l
        on l.tenant_id = p_tenant_id and l.identity_account_id = m.identity_account_id and l.status = 'accepted'
     where m.tenant_id = p_tenant_id and m.status = 'accepted'
    on conflict (tenant_id, person_id, app_account_id) where app_account_id is not null do nothing
    returning 1)
  select count(*) into v_transitive_proposed from ins;

  return jsonb_build_object(
    'people_created', v_people_created,
    'identity_links_proposed', v_identity_proposed,
    'app_account_links_proposed', v_app_proposed,
    'transitive_links_proposed', v_transitive_proposed);
end $$;

-- ══ D. DECIDE ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- `decided_by` is auth.uid() from the session, never a parameter — a caller must not be able to attribute a decision to
-- somebody else. Only a `proposed` row moves, so a decision is never silently overwritten.
create or replace function public.product_decide_person_link(
  p_tenant_id uuid, p_link_id uuid, p_decision text
) returns jsonb language plpgsql security definer set search_path = public volatile as $$
declare v_n integer := 0;
begin
  if not public.has_tenant_role(p_tenant_id, array['owner', 'admin']) then
    raise exception 'not authorized for tenant %', p_tenant_id using errcode = '42501';
  end if;
  if p_decision not in ('accepted', 'rejected') then
    raise exception 'decision must be accepted or rejected';
  end if;
  update public.person_account_links l
     set status = p_decision, decided_by = auth.uid(), decided_at = now()
   where l.id = p_link_id and l.tenant_id = p_tenant_id and l.status = 'proposed';
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end $$;

-- ══ E. LEAST PRIVILEGE ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Hosted Supabase's ALTER DEFAULT PRIVILEGES (0045) grants EXECUTE on new public functions straight to anon/authenticated
-- and `revoke from public` alone does not remove it, so every role is named. These are PRODUCT writes gated by the
-- tenant-role check inside each function; `connector_runner` is revoked — a person link is a human judgement, never
-- connector evidence. `service_role` is deliberately not named, matching the 0061/0073/0078 product-RPC precedent.
do $$
declare f text;
begin
  foreach f in array array[
    'public.product_propose_person_links(uuid)',
    'public.product_decide_person_link(uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated, connector_runner', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
