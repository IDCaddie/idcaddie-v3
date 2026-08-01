-- 0075_application_match_model.sql
--
-- Phase 7B — the explicit link between a DIRECTORY APPLICATION and a SaaS APPLICATION.
--
-- The two models stay separate, permanently:
--
--   directory_applications  what an identity provider exposes. "Who can sign in to this?"
--   public.apps             normalized software records. "What do we pay for, and under what contract?"
--
-- They answer different questions about overlapping things, and merging them would destroy both. A directory application with no
-- SaaS record is not an error (nobody has recorded a contract), and a SaaS record with no directory application is not an error
-- (nobody signs in via the IdP). Today there is NO link at all, which is why the Applications page has to say so in prose.
--
-- WHY A TABLE AND NOT A JOIN. Any join would have to be on something — name, label, domain — and every one of those is wrong:
-- "Slack" the Okta app and "Slack" the contract may be different tenants, different regions, or the same name owned by two
-- vendors. A match is a JUDGEMENT with a confidence and an author, so it is stored as a fact with provenance, not inferred at
-- read time. This is the same reasoning as connector supersession (0071): declare, never infer.
--
-- WHAT THIS MIGRATION DOES NOT DO. It runs no matcher. It creates zero matches. Nothing in the product reads it yet. It is the
-- contract that lets a matcher — human or automated — record its output truthfully when one exists. Building the matcher without
-- first fixing the shape of its output is how you get a name-based join.
--
-- Staging only. Additive: one table, no change to either model it references.

-- `apps` already carries unique (id, tenant_id); directory_applications does not, so the composite endpoint FK below has nothing
-- to reference. Adding it is redundant against the primary key and costs nothing, and it is what lets the database — rather than a
-- trigger — refuse a match whose two endpoints live in different tenants.
alter table public.directory_applications
  add constraint directory_applications_id_tenant_key unique (id, tenant_id);

create table if not exists public.application_matches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  -- The two endpoints. Both real rows; neither is created by matching.
  directory_application_id uuid not null references public.directory_applications (id) on delete cascade,
  app_id uuid not null references public.apps (id) on delete cascade,

  -- HOW the match was decided. `manual` is an operator's judgement; the automated methods are recorded distinctly so a low-quality
  -- heuristic can be found and revisited later rather than being indistinguishable from a human decision.
  method text not null,
  constraint application_matches_method_chk check (method in ('manual', 'exact_domain', 'exact_external_id', 'vendor_catalog', 'suggested')),

  -- Confidence is REQUIRED and bounded. A match without one is an assertion nobody can weigh.
  confidence text not null,
  constraint application_matches_confidence_chk check (confidence in ('high', 'medium', 'low')),

  -- Review state. A `suggested` match is NOT a match until someone accepts it — the product must be able to hold a proposal
  -- without acting on it, or every heuristic becomes a silent fact.
  status text not null default 'proposed',
  constraint application_matches_status_chk check (status in ('proposed', 'accepted', 'rejected')),

  -- Provenance. Who decided, when, and why — the same standard the connector lifecycle actions are held to.
  rationale text,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  constraint application_matches_decided_chk check (
    (status = 'proposed' and decided_at is null) or (status in ('accepted', 'rejected') and decided_at is not null)),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Both endpoints must belong to the SAME tenant as the match. Enforced by composite FK, not by a trigger, so it cannot be
  -- bypassed by a direct write.
  constraint application_matches_dir_tenant_fk foreign key (directory_application_id, tenant_id)
    references public.directory_applications (id, tenant_id) on delete cascade,
  constraint application_matches_app_tenant_fk foreign key (app_id, tenant_id)
    references public.apps (id, tenant_id) on delete cascade
);

-- At most ONE accepted match per DIRECTORY APPLICATION: a single identity-provider application is one product, so a second
-- accepted match would be a contradiction rather than extra information.
--
-- Deliberately NOT unique on the SaaS side. A workspace with two Okta organizations has two directory applications for the same
-- product — corporate Salesforce and subsidiary Salesforce — and both legitimately map to one contract. Constraining that would
-- force an operator to choose which organization "owns" a contract it actually covers, which is the multi-directory model
-- collapsing again. Proposals are unconstrained on both sides; several may compete until one is accepted.
create unique index if not exists application_matches_one_accepted_dir_idx
  on public.application_matches (tenant_id, directory_application_id) where status = 'accepted';
create index if not exists application_matches_app_idx on public.application_matches (tenant_id, app_id) where status = 'accepted';
create index if not exists application_matches_tenant_idx on public.application_matches (tenant_id, status);

comment on table public.application_matches is
  'Explicit, confidence-bearing links between directory_applications (identity-provider view) and public.apps (normalized software). The two models remain separate; a match is a recorded judgement with provenance, never a name-based join. No matcher populates this yet.';

-- RLS on, no policy: nothing may read or write this from a browser. The read contract will be a product RPC when a consumer
-- exists — adding a policy before then would open a surface with no caller.
alter table public.application_matches enable row level security;
revoke all on public.application_matches from public, anon, authenticated, connector_runner;
