-- =====================================================================
-- CueIQ — TEST seed: one show per band on a single festival day.
-- Purpose: exercise the Overview schedule (cross-band time-ordering,
--          mobile cards, JPG export) + StatusCell/approval buttons.
-- Tenant: derived per band from public.groups (real "A Lot Of Tone" label).
-- CLEANUP (one line):  delete from public.events where name like '🧪 TEST FEST%';
-- Idempotent: re-running deletes the prior TEST FEST seed first (cascades children).
-- =====================================================================

delete from public.events where name like '🧪 TEST FEST%';

with ev(eid, gid, ename, status, stage_s, stage_e, booth_s, booth_e, photo_s, photo_e) as (
  values
    -- All 8 share ONE name so they collapse into a single festival header in the
    -- รายงาน view (band differs per row). Statuses cycled (2× pending_review to test
    -- the approve popup). Times staggered so the cross-band schedule interleaves.
    ('00000000-0000-0000-0000-0000000ffe01'::uuid,'bf6ace31-eed8-4b84-bef3-7b75d45d101e'::uuid,'🧪 TEST FEST','pending_review','10:00','10:30','10:40','11:10','11:20','11:35'),
    ('00000000-0000-0000-0000-0000000ffe02'::uuid,'9fa66a5c-5be6-4c15-a4a7-67a51f80f066'::uuid,'🧪 TEST FEST','draft',         '10:45','11:15','11:25','11:55','12:05','12:20'),
    ('00000000-0000-0000-0000-0000000ffe03'::uuid,'cfe82737-77ec-4c03-8cd8-858fbfb86a97'::uuid,'🧪 TEST FEST','in_progress',   '11:30','12:00','12:10','12:40','12:50','13:05'),
    ('00000000-0000-0000-0000-0000000ffe04'::uuid,'4a7ae06f-ac32-40ad-8d10-5bc7418dd323'::uuid,'🧪 TEST FEST','approved',      '12:15','12:45','12:55','13:25','13:35','13:50'),
    ('00000000-0000-0000-0000-0000000ffe05'::uuid,'cefc2fec-f36c-4af8-9dfd-5584aa8ba06f'::uuid,'🧪 TEST FEST','pending_review','13:00','13:30','13:40','14:10','14:20','14:35'),
    ('00000000-0000-0000-0000-0000000ffe06'::uuid,'4bc8f4ca-f9a0-4db7-94dc-999077287e40'::uuid,'🧪 TEST FEST','draft',         '13:45','14:15','14:25','14:55','15:05','15:20'),
    ('00000000-0000-0000-0000-0000000ffe07'::uuid,'d533b546-edf5-427e-a31f-8f32399aeeac'::uuid,'🧪 TEST FEST','in_progress',   '14:30','15:00','15:10','15:40','15:50','16:05'),
    ('00000000-0000-0000-0000-0000000ffe08'::uuid,'c8788874-d6f9-41bd-a675-5d7628a15881'::uuid,'🧪 TEST FEST','approved',    '15:15','15:45','15:55','16:25','16:35','16:50')
)
insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
select ev.eid, g.tenant_id, ev.gid, ev.ename,
       '2026-06-28', '🧪 Lot of Live (TEST)', 'idol',
       ev.stage_s::time, ev.photo_e::time, ev.status,
       'TEST seed — ลบได้ด้วย name like 🧪 TEST FEST%', false, false
from ev join public.groups g on g.id = ev.gid;

-- Schedule items: on_location (90 min before stage) + stage + booth + photo,
-- generated from the same row so every test show has a full, time-ordered day.
with ev(eid, gid, stage_s, stage_e, booth_s, booth_e, photo_s, photo_e) as (
  values
    ('00000000-0000-0000-0000-0000000ffe01'::uuid,'bf6ace31-eed8-4b84-bef3-7b75d45d101e'::uuid,'10:00','10:30','10:40','11:10','11:20','11:35'),
    ('00000000-0000-0000-0000-0000000ffe02'::uuid,'9fa66a5c-5be6-4c15-a4a7-67a51f80f066'::uuid,'10:45','11:15','11:25','11:55','12:05','12:20'),
    ('00000000-0000-0000-0000-0000000ffe03'::uuid,'cfe82737-77ec-4c03-8cd8-858fbfb86a97'::uuid,'11:30','12:00','12:10','12:40','12:50','13:05'),
    ('00000000-0000-0000-0000-0000000ffe04'::uuid,'4a7ae06f-ac32-40ad-8d10-5bc7418dd323'::uuid,'12:15','12:45','12:55','13:25','13:35','13:50'),
    ('00000000-0000-0000-0000-0000000ffe05'::uuid,'cefc2fec-f36c-4af8-9dfd-5584aa8ba06f'::uuid,'13:00','13:30','13:40','14:10','14:20','14:35'),
    ('00000000-0000-0000-0000-0000000ffe06'::uuid,'4bc8f4ca-f9a0-4db7-94dc-999077287e40'::uuid,'13:45','14:15','14:25','14:55','15:05','15:20'),
    ('00000000-0000-0000-0000-0000000ffe07'::uuid,'d533b546-edf5-427e-a31f-8f32399aeeac'::uuid,'14:30','15:00','15:10','15:40','15:50','16:05'),
    ('00000000-0000-0000-0000-0000000ffe08'::uuid,'c8788874-d6f9-41bd-a675-5d7628a15881'::uuid,'15:15','15:45','15:55','16:25','16:35','16:50')
)
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
select g.tenant_id, ev.eid, x.kind, x.label, '🧪 Lot of Live (TEST)',
       x.st::time, nullif(x.et,'')::time, x.ord
from ev
join public.groups g on g.id = ev.gid
cross join lateral (values
  ('on_location','ถึงสถานที่/แต่งตัว', to_char(ev.stage_s::time - interval '90 min','HH24:MI'), '',        1),
  ('stage',      'Stage',             ev.stage_s, ev.stage_e, 2),
  ('booth',      'Booth',             ev.booth_s, ev.booth_e, 3),
  ('photo',      'Photo',             ev.photo_s, ev.photo_e, 4)
) as x(kind, label, st, et, ord);
