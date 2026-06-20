-- =====================================================================
-- CueIQ — Loop audio per setlist item
--
-- A setlist item (typically MC) can loop its BGM to fill its set time; Live Mode
-- fades it out to end exactly at the item's duration. Per-item, off by default,
-- toggled in Live Mode (Manual mode only). Syncs across devices via the existing
-- setlist refetch/broadcast.
--
-- Run via: npm run migrate supabase/migrations/0014_setlist_loop.sql  (safe to re-run)
-- =====================================================================

alter table public.setlist_items
  add column if not exists loop_audio boolean not null default false;
