-- =====================================================================
-- CueIQ — Phase 2: Event deadline (4.8 — deadline tracking)
--
-- A label sets when each event's setlist must be finalized. Visual status only
-- (countdown / overdue) — groups flagged exempt_from_deadline (e.g. an in-house
-- band) skip the pressure. Active push/Line notifications are deferred infra.
--
-- Run in Supabase → SQL Editor (owner). Safe to re-run.
-- (events already has RLS + grants from 0001 — UPDATE covers the new columns.)
-- =====================================================================

alter table public.events add column if not exists deadline timestamptz;
alter table public.events add column if not exists deadline_note text;
