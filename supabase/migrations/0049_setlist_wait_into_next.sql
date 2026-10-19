-- 0049_setlist_wait_into_next.sql
-- พี่ 2026-10-19: the setlist builder's "เล่นซ้อน" and "เผื่อเวลาหลัง" become ONE field,
-- "ตั้งเวลา", on every row but the first: buffer_before_seconds, signed - negative = comes
-- in that long before the row above ends (as before), positive = waits that long after it
-- ends. "เผื่อเวลาหลัง" (buffer_after_seconds) is no longer on screen, so each row's wait
-- moves onto the row after it (added, so an overlap there nets out: wait 8 then -5 = +3 -
-- Live Mode and the run sheet run exactly as long), and a last row's is dropped (on
-- 2026-10-19 no last row had one: 25 waits, all with a row after them).
-- lib/time.ts foldWaitsIntoNext is the same rule, for a setlist version being restored.
-- setlist_items has no update guard trigger. Idempotent: a second run finds no waits.
-- Run with: npm run migrate supabase/migrations/0049_setlist_wait_into_next.sql

with ordered as (
  select id,
         buffer_after_seconds as wait,
         lead(id) over (partition by event_id order by sort_order, id) as next_id
  from public.setlist_items
)
update public.setlist_items n
set buffer_before_seconds = greatest(-300, least(300, n.buffer_before_seconds + o.wait))
from ordered o
where o.next_id = n.id
  and o.wait > 0;

update public.setlist_items
set buffer_after_seconds = 0
where buffer_after_seconds <> 0;
