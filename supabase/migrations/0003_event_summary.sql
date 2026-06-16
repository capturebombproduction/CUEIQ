-- =====================================================================
-- CueIQ — Phase 2: event summary fields
-- map_url       : Google Maps link for the venue (pasted or auto-suggested)
-- costume_theme : e.g. "All Black"
-- Other summary data is derived from existing schedule_items + show times.
-- Run in Supabase → SQL Editor. Safe to re-run.
-- =====================================================================

alter table public.events add column if not exists map_url       text;
alter table public.events add column if not exists costume_theme text;

-- events already has select/insert/update/delete granted to `authenticated`
-- (migration 0001), so the new columns need no extra grant.
