-- =====================================================================
-- CueIQ — REAL seed: "ANGeVIL✟ PHASE 2.0: debut stage"
--   Date 2026-06-27 (Sat) · Union Mall — Co-Event Space, Zone A, 4 FL.
--   Label "A Lot Of Tone" acts ONLY (7): G-D!, HatoBito, TERASHI, LUMIN+US,
--   KŌMA, Seishin Kakumei, ANGeVIL✟ (headliner debut). One shared event name
--   so the Overview collapses them into a single festival header (band per row).
--   Guest acts (ZYN, G-D! aside, Neko Pon!, PEACH YOU, STARRY☆NITE, NIKKO NIKKO,
--   The Glass Girls, Castella) are NOT label bands → intentionally not seeded.
--   Idempotent: re-running replaces the festival cleanly (fixed UUIDs + delete-first).
-- =====================================================================

-- 1) CLEANUP — clear test/demo + retired real events. KEEP every band's template:
--    7× 'Demo Draft Events' (is_template) + Seishin's 'แม่แบบ (NIKKO)'. Targeted by
--    id/name so re-running never touches data created later. (Cascades children;
--    library songs are untouched — only the setlist LINKS go.)
delete from public.events where name like '🧪 TEST FEST%';                          -- 8 test rows
delete from public.events where id in (
  'd3a2a9b0-195d-4415-beab-0a1abdd3db21', -- Celebrate 3rd Year with NIKKO NIKKO (retired real)
  '750fd3d7-c114-4ee9-b9d0-a38f46274be4', -- Heart Repair Shop : Maid Cafe Event (retired real)
  'b22c81b2-7893-4ec0-bcc7-453147070bf9', -- Come backk ANGeVIL We're Back by iPP (retired draft)
  '6ee3054d-b215-4397-9aea-f5c09c774c6b', -- Demo Traning (practice demo)
  '397213af-cf98-4183-b288-a448f70fde37'  -- Seishin's 'Demo Draft Events' (redundant — NIKKO is its template)
);

-- 2) G-D! — HatoBito's unit; a label act that has no group row yet. Colour is a
--    placeholder (amber) — change it in the band manager any time.
insert into public.groups (id, tenant_id, name, color)
values ('0000000a-0000-0000-0000-000000000d01',
        '00000000-0000-0000-0000-000000000001', 'G-D!', '#F59E0B')
on conflict (id) do update set name = excluded.name, color = excluded.color;

-- 3) Festival events — one per act, all sharing ONE name. show_start = stage start,
--    hard_out = booth end (last commitment). All start as 'draft'.
delete from public.events where name = 'ANGeVIL✟ PHASE 2.0: debut stage';

insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
values
  ('0000000a-0000-0000-0000-0000000a2e01','00000000-0000-0000-0000-000000000001','0000000a-0000-0000-0000-000000000d01','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','11:50','14:10','draft',null,false,false),
  ('0000000a-0000-0000-0000-0000000a2e02','00000000-0000-0000-0000-000000000001','4a7ae06f-ac32-40ad-8d10-5bc7418dd323','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','15:30','21:00','draft',null,false,false),
  ('0000000a-0000-0000-0000-0000000a2e03','00000000-0000-0000-0000-000000000001','cfe82737-77ec-4c03-8cd8-858fbfb86a97','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','14:00','21:00','draft',null,false,false),
  ('0000000a-0000-0000-0000-0000000a2e04','00000000-0000-0000-0000-000000000001','d533b546-edf5-427e-a31f-8f32399aeeac','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','14:20','21:00','draft',null,false,false),
  ('0000000a-0000-0000-0000-0000000a2e05','00000000-0000-0000-0000-000000000001','9fa66a5c-5be6-4c15-a4a7-67a51f80f066','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','14:40','21:00','draft',null,false,false),
  ('0000000a-0000-0000-0000-0000000a2e06','00000000-0000-0000-0000-000000000001','c8788874-d6f9-41bd-a675-5d7628a15881','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','15:00','21:00','draft',null,false,false),
  ('0000000a-0000-0000-0000-0000000a2e07','00000000-0000-0000-0000-000000000001','4bc8f4ca-f9a0-4db7-94dc-999077287e40','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27','Union Mall — Co-Event Space, Zone A, 4 FL.','idol','16:40','21:00','draft','PHASE 2.0: debut Stage — headliner (60-min set)',false,false);

-- 4) Schedule items — Stage + Booth for every act. Booth letter lives in location.
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
select '00000000-0000-0000-0000-000000000001'::uuid, v.eid, x.kind, x.label, x.loc,
       x.st::time, x.et::time, x.ord
from (values
  ('0000000a-0000-0000-0000-0000000a2e01'::uuid,'11:50','12:10','I',  '12:40','14:10'),  -- G-D!
  ('0000000a-0000-0000-0000-0000000a2e02'::uuid,'15:30','15:50','I-H','19:30','21:00'),  -- HatoBito
  ('0000000a-0000-0000-0000-0000000a2e03'::uuid,'14:00','14:20','E',  '19:30','21:00'),  -- TERASHI
  ('0000000a-0000-0000-0000-0000000a2e04'::uuid,'14:20','14:40','D',  '19:30','21:00'),  -- LUMIN+US
  ('0000000a-0000-0000-0000-0000000a2e05'::uuid,'14:40','15:00','G',  '19:30','21:00'),  -- KŌMA
  ('0000000a-0000-0000-0000-0000000a2e06'::uuid,'15:00','15:20','C',  '19:30','21:00'),  -- Seishin Kakumei
  ('0000000a-0000-0000-0000-0000000a2e07'::uuid,'16:40','17:40','A',  '19:30','21:00')   -- ANGeVIL✟
) as v(eid, stage_s, stage_e, booth, booth_s, booth_e)
cross join lateral (values
  ('stage','Stage', null,              v.stage_s, v.stage_e, 2),
  ('booth','Booth', 'Booth '||v.booth, v.booth_s, v.booth_e, 3)
) as x(kind, label, loc, st, et, ord);

-- 5) ANGeVIL✟ extra: Poster Sign 13:30–15:00 (afternoon activity from the timetable).
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
values ('00000000-0000-0000-0000-000000000001','0000000a-0000-0000-0000-0000000a2e07',
        'other','Poster Sign','Booth A','13:30','15:00',1);
