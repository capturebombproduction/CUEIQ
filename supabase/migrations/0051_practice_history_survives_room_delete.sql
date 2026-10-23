-- 0051_practice_history_survives_room_delete.sql
-- Measured 2026-10-23: deleting a practice room wiped the band's practice history with
-- it. Seishin's room "ซ้อมแบบดิจิตอล" (June → October, 104 runs, 2 journal notes,
-- 13 attendance rows) was deleted on 10-19 and every row went with it, because 0024
-- made event_id NOT NULL + ON DELETE CASCADE on all four practice tables. The app only
-- ever INSERTs runs; pg_stat n_tup_del = 118 is all cascades.
--
-- From here a room's delete keeps what the band DID there:
--   practice_runs  (the auto-log: which song, how long, at what speed)       → SET NULL
-- and still removes, as the delete-room confirm promises, everything else:
--   practice_songs      (the room's own list / set)                          → CASCADE
--   practice_attendance (the room's per-day check-in strip; unique per room) → CASCADE
--   practice_logs       (the journal people TYPED - notes, homework, and the
--                        staff-only coaching notes about members)            → CASCADE
-- The journal stays with the room on purpose: an Ar who deletes a room to be rid of
-- what was written in it must be able to, and a room-less note would show nowhere and
-- could never be deleted by anyone. (A first draft of this file also set the journal
-- to SET NULL; the review of 2026-10-23 caught that, before it was ever applied.)
-- song_id on practice_runs is already SET NULL (0024) - same idea.
--
-- A run with event_id NULL is history with no room. It shows nowhere today and breaks
-- nothing: the room stats and the journal select by event_id, and the two readers that
-- select by group_id (dashboard, event page) pass the rows through
-- lib/next-show.ts practiceRoomByGroup, which skips a null event_id. It stays in the
-- table and in the daily backup. group_id still CASCADEs - deleting a BAND removes its
-- history, on purpose.
-- Run with: npm run migrate supabase/migrations/0051_practice_history_survives_room_delete.sql

alter table public.practice_runs alter column event_id drop not null;
alter table public.practice_runs drop constraint if exists practice_runs_event_id_fkey;
alter table public.practice_runs
  add constraint practice_runs_event_id_fkey
  foreign key (event_id) references public.events(id) on delete set null;
