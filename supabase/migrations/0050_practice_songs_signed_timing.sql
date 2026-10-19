-- 0050_practice_songs_signed_timing.sql
-- พี่ 2026-10-19: "ในเทรนนิ่งยังกดเป็นค่าบวกไม่ได้". The room's own set takes the same
-- "เข้าหลังเพลงก่อนหน้า" number as a show's setlist: signed, like
-- setlist_items.buffer_before_seconds - negative = comes in that long before the song
-- above ends, positive = waits that long after it ends, 0 = straight after.
-- 0048's overlap_seconds held only the overlap (0..300, positive = a lead), so it moves
-- here negated. It stays on the table, unread by the web from now on: a desktop app
-- still on v0.1.40 / v0.1.41 writes it until its update lands, and a write there must
-- not fail.
-- Run with: npm run migrate supabase/migrations/0050_practice_songs_signed_timing.sql

alter table public.practice_songs
  add column if not exists buffer_before_seconds smallint not null default 0;

alter table public.practice_songs
  drop constraint if exists practice_songs_buffer_before_range;
alter table public.practice_songs
  add constraint practice_songs_buffer_before_range
  check (buffer_before_seconds between -300 and 300);

-- idempotent: only rows not yet carried over (a second run finds them all non-zero or 0/0)
update public.practice_songs
set buffer_before_seconds = -overlap_seconds
where overlap_seconds > 0
  and buffer_before_seconds = 0;
