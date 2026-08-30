-- 0042 — MORE THAN ONE ถ่ายรูป per event, as long as each round has a NAME.
--
-- 0036 capped it at one row per event, and that cap was right for the problem it
-- solved: bands and staff filled the photo call-time from several devices at once
-- (the Overview inline cell and the schedule editor write the same row), leaving
-- 2–3 conflicting photo rows that the Overview then picked from arbitrarily.
--
-- It was wrong about the world. A real event came in with TWO costumes and a photo
-- call for each, and the band could not enter the second one — reported through the
-- in-app feedback channel on 2026-08-15 ("งานมี 2 ชุด ถ่ายทั้ง 2 ชุด แต่สร้าง photo
-- session ได้แค่ 1 อัน"). พี่'s call: allow several, but each has to be named.
--
-- The key is the NAME, normalised:
--   • an unnamed row and one named "ถ่ายรูป" are the SAME round — which is exactly
--     what the concurrent-device case produces, because the Overview cell inserts
--     with label "ถ่ายรูป" and the schedule editor's new row starts with none. So
--     the race 0036 closed stays closed: both devices still collide on one key and
--     the existing adopt-the-row path still runs;
--   • two rows the operator NAMED differently ("ชุด 1" / "ชุด 2") are two rounds,
--     and are now allowed;
--   • btrim so " ชุด 1" cannot masquerade as a different round from "ชุด 1".
--
-- Safe to swap: 0036's index guarantees at most one photo row per event today, so
-- no existing pair can violate the new one.
drop index if exists public.schedule_items_one_photo_per_event;

create unique index if not exists schedule_items_photo_round_per_event
  on public.schedule_items (event_id, coalesce(nullif(btrim(label), ''), 'ถ่ายรูป'))
  where kind = 'photo';
