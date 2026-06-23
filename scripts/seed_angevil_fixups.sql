-- =====================================================================
-- CueIQ — follow-up fixups after the ANGeVIL✟ PHASE 2.0 seed:
--   (A) Celebrate 3rd Year = a VISIBLE real event again (is_template=false),
--       PLUS a SEPARATE hidden template clone for Seishin (so the band keeps a
--       "สร้างจากแม่แบบ" source AND the real show shows on the schedule).
--   (C) G-D! is HatoBito's UNIT → fold its festival slot into HatoBito's group_id
--       and drop the standalone G-D! group (no separate band/account).
-- UPDATEs on public.events trip the events_guard_update trigger when auth.uid()
-- is null (i.e. via the Management API), so disable it around them — same pattern
-- as prior service-role data ops. Idempotent (fixed ids).
-- =====================================================================

alter table public.events disable trigger events_guard_update;

-- (A) Celebrate back to a normal, visible event (shows on Overview/Dashboard).
update public.events set is_template = false
 where id = 'd3a2a9b0-195d-4415-beab-0a1abdd3db21';

-- (C) Reassign the G-D! slot (11:50) to HatoBito's group.
update public.events set group_id = '4a7ae06f-ac32-40ad-8d10-5bc7418dd323'
 where id = '0000000a-0000-0000-0000-0000000a2e01';

alter table public.events enable trigger events_guard_update;

-- (C) Drop the now-unused standalone G-D! group.
delete from public.groups where id = '0000000a-0000-0000-0000-000000000d01';

-- (A) Seishin's SEPARATE template = a clone of Celebrate (schedule + setlist),
--     is_template=true (hidden from Overview/Dashboard), event_date null like a
--     skeleton. Fixed id → re-running replaces it cleanly.
delete from public.events where id = '0000000a-0000-0000-0000-0000000a7e10';
insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
select '0000000a-0000-0000-0000-0000000a7e10', tenant_id, group_id,
       'แม่แบบ (Seishin)', null, venue, event_type,
       show_start_time, hard_out_time, 'draft', notes, true, false
  from public.events where id = 'd3a2a9b0-195d-4415-beab-0a1abdd3db21';

insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
select tenant_id, '0000000a-0000-0000-0000-0000000a7e10', kind, label, location,
       start_time, end_time, sort_order
  from public.schedule_items
 where event_id = 'd3a2a9b0-195d-4415-beab-0a1abdd3db21';

insert into public.setlist_items
  (tenant_id, event_id, kind, title, song_id, sort_order, duration_seconds,
   buffer_before_seconds, buffer_after_seconds, mic_slots, notes, loop_audio)
select tenant_id, '0000000a-0000-0000-0000-0000000a7e10', kind, title, song_id,
       sort_order, duration_seconds, buffer_before_seconds, buffer_after_seconds,
       mic_slots, notes, loop_audio
  from public.setlist_items
 where event_id = 'd3a2a9b0-195d-4415-beab-0a1abdd3db21';
