-- 0051_practice_history_survives_room_delete.sql
-- Measured 2026-10-23: deleting a practice room wiped the band's practice history with
-- it. Seishin's room "ซ้อมแบบดิจิตอล" (June → October, 104 runs, 2 journal notes,
-- 13 attendance rows) was deleted on 10-19 and every row went with it, because 0024
-- made event_id NOT NULL + ON DELETE CASCADE on all four practice tables. The app only
-- ever INSERTs runs; pg_stat n_tup_del = 118 is all cascades.
--
-- From here a room's delete keeps what the band DID and WROTE:
--   practice_runs  (the auto-log: what was played, how long, at what speed)  → SET NULL
--   practice_logs  (the journal: notes, homework, problems people typed)     → SET NULL
-- and still removes what IS the room:
--   practice_songs      (the room's own list / set)                          → CASCADE
--   practice_attendance (the room's per-day check-in strip; unique per room) → CASCADE
-- song_id on practice_runs is already SET NULL (0024) - same idea.
--
-- A row with event_id NULL is history with no room: every reader selects by
-- event_id (= the room), so it shows nowhere today and breaks nothing; it stays in
-- the table and in the daily backup. group_id still CASCADEs - deleting a BAND
-- removes its history, on purpose.
-- Run with: npm run migrate supabase/migrations/0051_practice_history_survives_room_delete.sql

alter table public.practice_runs alter column event_id drop not null;
alter table public.practice_runs drop constraint if exists practice_runs_event_id_fkey;
alter table public.practice_runs
  add constraint practice_runs_event_id_fkey
  foreign key (event_id) references public.events(id) on delete set null;

alter table public.practice_logs alter column event_id drop not null;
alter table public.practice_logs drop constraint if exists practice_logs_event_id_fkey;
alter table public.practice_logs
  add constraint practice_logs_event_id_fkey
  foreign key (event_id) references public.events(id) on delete set null;
