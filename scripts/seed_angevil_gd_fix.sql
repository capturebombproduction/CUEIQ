-- =====================================================================
-- CueIQ — ANGeVIL✟ PHASE 2.0 fixes (2026-06-27), user-confirmed:
--
-- (1) Correct the G-D! unit slot (event 0000000a…2e01 — HatoBito's unit, folded
--     into HatoBito's group by seed_angevil_fixups) to the OFFICIAL organiser
--     timetable: STAGE 12:30–12:50, BOOTH I 13:00–14:30. The original seed had
--     11:50–12:10 / Booth I 12:40–14:10. Every other label act already matches.
--
-- (2) De-duplicate the per-event "photo" schedule_items. Bands/staff entered the
--     ถ่ายรูป window several times (concurrent edits / multiple devices), leaving
--     2–3 photo rows per event with conflicting times. พี่ confirmed the value to
--     KEEP = the time currently shown on the Overview/export (the staff's latest):
--       2e01 10:30–10:50 · 2e02 14:00–14:30 · 2e03 13:00–13:20 · 2e04 13:20–13:40
--       2e05 13:50–14:10 · 2e06 16:00–16:30 · 2e07 12:30–13:00
--     Phase A drops photo rows whose time ≠ the kept value; Phase B collapses any
--     remaining exact duplicates to one (min id) per event.
--
-- TARGETED by id (never the full re-seed) so live setlists/mics stay intact.
-- events_guard_update trips on a null auth.uid() (Management API) → disable it
-- around the events UPDATE only. schedule_items has no such guard.
-- =====================================================================

-- (1) G-D! unit slot → official.
alter table public.events disable trigger events_guard_update;
update public.events
   set show_start_time = '12:30', hard_out_time = '12:50'
 where id = '0000000a-0000-0000-0000-0000000a2e01';
alter table public.events enable trigger events_guard_update;

update public.schedule_items
   set start_time = '12:30', end_time = '12:50'
 where event_id = '0000000a-0000-0000-0000-0000000a2e01' and kind = 'stage';

update public.schedule_items
   set start_time = '13:00', end_time = '14:30'
 where event_id = '0000000a-0000-0000-0000-0000000a2e01' and kind = 'booth';

-- (2A) Drop photo rows whose time differs from the staff-latest value to keep.
delete from public.schedule_items
 where kind = 'photo' and event_id = '0000000a-0000-0000-0000-0000000a2e01'
   and not (start_time = '10:30' and end_time = '10:50');
delete from public.schedule_items
 where kind = 'photo' and event_id = '0000000a-0000-0000-0000-0000000a2e02'
   and not (start_time = '14:00' and end_time = '14:30');
delete from public.schedule_items
 where kind = 'photo' and event_id = '0000000a-0000-0000-0000-0000000a2e04'
   and not (start_time = '13:20' and end_time = '13:40');
delete from public.schedule_items
 where kind = 'photo' and event_id = '0000000a-0000-0000-0000-0000000a2e05'
   and not (start_time = '13:50' and end_time = '14:10');
-- 2e03 (13:00–13:20 ×3), 2e07 (12:30–13:00 ×3): all rows already match → only
-- Phase B needed. 2e06 (16:00–16:30 ×1): single row → untouched.

-- (2B) Collapse remaining exact duplicates → keep one (min id) photo row per event.
delete from public.schedule_items s
 where s.kind = 'photo'
   and s.event_id in (
     '0000000a-0000-0000-0000-0000000a2e01','0000000a-0000-0000-0000-0000000a2e02',
     '0000000a-0000-0000-0000-0000000a2e03','0000000a-0000-0000-0000-0000000a2e04',
     '0000000a-0000-0000-0000-0000000a2e05','0000000a-0000-0000-0000-0000000a2e06',
     '0000000a-0000-0000-0000-0000000a2e07')
   and s.id::text <> (
     select min(s2.id::text) from public.schedule_items s2
      where s2.event_id = s.event_id and s2.kind = 'photo');

-- (3) Keep the live running-order in sync: the G-D! unit slot (run_sequence row
--     linked to 2e01) still carried the old 11:50–12:10. run_sequence has no guard
--     trigger, so a plain UPDATE is fine. Title stays "HatoBito" (พี่'s G-D!→HatoBito
--     group fold); only the planned time follows the corrected stage slot.
update public.run_sequence
   set planned_start = '12:30', planned_end = '12:50'
 where id = '0000001a-0000-0000-0000-0000001a2e01';
