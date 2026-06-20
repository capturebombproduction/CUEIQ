-- =====================================================================
-- CueIQ — Last-show time on the event (permanent, cross-device record)
--
-- "จบโชว์" in Live Mode saves the accumulated time here so it's a durable record
-- (shows on every device + the dashboard), not just localStorage. Still clearable
-- via the ล้าง button (sets both back to null). Survives a normal Reset Show.
--
-- Run via: npm run migrate supabase/migrations/0015_event_last_run.sql  (safe to re-run)
-- =====================================================================

alter table public.events add column if not exists last_run_seconds int;
alter table public.events add column if not exists last_run_at timestamptz;
