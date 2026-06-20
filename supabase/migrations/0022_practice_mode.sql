-- 0022_practice_mode.sql
-- Slice 1 of Practice Mode (โหมดซ้อม). A practice room is a normal event flagged
-- is_practice=true: it reuses the band's song library + setlist, but is hidden from
-- the normal event lists (dashboard / overview / reminders) and is opened in the
-- dedicated practice player (/events/[id]/practice) instead of Live Mode. RLS is
-- unchanged — a practice event is owned by a band like any event, so the existing
-- per-band events policies (events_select / events_write) already govern who may
-- read / create / edit it (admin or the band's Ar create; members may view + play).
alter table public.events
  add column if not exists is_practice boolean not null default false;
