-- 0040_app_user_absence_fields.sql
--
-- INERT schema support for NON-DESTRUCTIVE Slack absence/stale marking (the docs/05 2026-07-03 design; wired by a LATER
-- resolver/store PR — nothing reads or writes these columns yet). The Slack sync is upsert-only today, so an app_user no
-- longer returned by the provider lingers as apparently-current forever. This adds the minimal presence fields:
--
--   * `app_users.last_seen_at`  — set to the run's observed_at each time the user IS present in a complete successful
--                                 sync (the raw presence signal). Nullable: rows predating absence-tracking are unknown.
--   * `app_users.sync_status`   — the derived presence flag: 'active' (present in the last complete sync — the default,
--                                 so every existing + new row starts active) or 'stale' (absent from the last complete
--                                 successful sync). DISTINCT from `app_users.status` (the provider's OWN account status,
--                                 e.g. Slack deleted/restricted) and from `manual_sync_runs.status` (the run outcome).
--   * `manual_sync_runs.app_users_marked_stale` — the per-run audit count of rows marked stale (0 for all prior runs).
--
-- NON-DESTRUCTIVE BY DESIGN (the invariant the later wiring PR must keep): absence NEVER deletes an app_user / person /
-- match — it only flips `sync_status` to 'stale'; a returning user flips back to 'active'. Marking happens ONLY after a
-- COMPLETE SUCCESSFUL sync, tenant+app-scoped, as the member JWT (RLS-gated by the EXISTING 0004 update policy).
--
-- Migration-safety: additive `add column` only (nullable, or NOT NULL with a default — no table rewrite hazard on these
-- sizes) + CHECK constraints. Nothing destructive; NO policy change (the 0004 insert+update-only posture on app_users is
-- untouched), NO grant change (connector_runner gets NOTHING on app_users), NO browser-role change.
--
-- RISK-007 remains OPEN; Phase C remains BLOCKED (unrelated to this graph-presence change; stated for continuity).

begin;

alter table public.app_users
  add column last_seen_at timestamptz,
  add column sync_status text not null default 'active'
    constraint app_users_sync_status_check check (sync_status in ('active', 'stale'));

alter table public.manual_sync_runs
  add column app_users_marked_stale integer not null default 0
    constraint manual_sync_runs_marked_stale_nonneg check (app_users_marked_stale >= 0);

commit;
