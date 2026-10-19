-- 0048_practice_songs_overlap.sql
-- พี่ 2026-10-19: "ห้องซ้อมมันล็อค setlist ตามงาน อยากให้สามารถสร้างเองได้". The room's
-- own list (practice_songs) becomes a set of its own: ordered (sort_order, already there)
-- and with a "เล่นซ้อน" per song - how many seconds it comes in before the song above it
-- ends, the same number a show's setlist_items.buffer_before_seconds holds (there as a
-- negative). Stored positive here: the room has no legacy "wait" to keep apart from it.
-- 0 = after the song above ends. 300 = the setlist builder's own ceiling.
-- Writes go through the existing practice_songs_update policy (0038): the band's members.
-- Run with: npm run migrate supabase/migrations/0048_practice_songs_overlap.sql

alter table public.practice_songs
  add column if not exists overlap_seconds smallint not null default 0;

alter table public.practice_songs
  drop constraint if exists practice_songs_overlap_seconds_range;
alter table public.practice_songs
  add constraint practice_songs_overlap_seconds_range
  check (overlap_seconds between 0 and 300);
