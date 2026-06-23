-- =====================================================================
-- CueIQ — REAL seed: "SPORT DAY"  (A Lot Of Tone 'SPORT DAY')
--   Date 2026-07-04 (Sat) · Building 32, 7th Floor, Student Welfare Building,
--   Chandrakasem Rajabhat University.
--   Two parts:
--   (1) per-band EVENTS for the 6 LABEL bands that take the stage (TERASHI,
--       LUMIN+US, KŌMA, Seishin Kakumei, ANGeVIL✟, HatoBito) — each with its stage
--       slot + the shared 17:40–19:50 booth window. One shared name "SPORT DAY" so
--       the Overview collapses them into a single festival header.
--   (2) the festival-wide RUNNING ORDER (run_sequence — Event Live Mode) = a faithful
--       copy of the EVENT TIMETABLE: register/gate, opening, the games, break, the
--       award ceremony, every band slot (incl. the GUEST acts Chocolatière + Castella
--       as band lines with NO event link — they're not label bands), HatoBito's 1st
--       performance, groupshot, booth, poster sign, lucky draw, closing.
--   hard_out_time = the band's STAGE end (off-stage time) — NOT the booth end; the
--   booth window lives only in the booth schedule_item (lesson from the ANGeVIL seed).
--   INSERT-only (delete-by-name first for idempotency); no UPDATE, so it never trips
--   events_guard_update and is safe to run while bands use prod. Re-running replaces
--   this festival cleanly (fixed UUIDs + delete-first).
-- =====================================================================

delete from public.run_sequence where event_name = 'SPORT DAY';
delete from public.events       where name       = 'SPORT DAY';

-- ---------------------------------------------------------------------
-- (1) Per-band events — 6 label bands on the stage block.
-- ---------------------------------------------------------------------
insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
values
  ('0000000d-0000-0000-0000-0000000d2e01','00000000-0000-0000-0000-000000000001','cfe82737-77ec-4c03-8cd8-858fbfb86a97','SPORT DAY','2026-07-04','Building 32, 7th Floor, Student Welfare Building, Chandrakasem Rajabhat University','idol','15:45','15:50','draft',null,false,false), -- TERASHI
  ('0000000d-0000-0000-0000-0000000d2e02','00000000-0000-0000-0000-000000000001','d533b546-edf5-427e-a31f-8f32399aeeac','SPORT DAY','2026-07-04','Building 32, 7th Floor, Student Welfare Building, Chandrakasem Rajabhat University','idol','16:00','16:05','draft',null,false,false), -- LUMIN+US
  ('0000000d-0000-0000-0000-0000000d2e03','00000000-0000-0000-0000-000000000001','9fa66a5c-5be6-4c15-a4a7-67a51f80f066','SPORT DAY','2026-07-04','Building 32, 7th Floor, Student Welfare Building, Chandrakasem Rajabhat University','idol','16:05','16:10','draft',null,false,false), -- KŌMA
  ('0000000d-0000-0000-0000-0000000d2e04','00000000-0000-0000-0000-000000000001','c8788874-d6f9-41bd-a675-5d7628a15881','SPORT DAY','2026-07-04','Building 32, 7th Floor, Student Welfare Building, Chandrakasem Rajabhat University','idol','16:10','16:15','draft',null,false,false), -- Seishin Kakumei
  ('0000000d-0000-0000-0000-0000000d2e05','00000000-0000-0000-0000-000000000001','4bc8f4ca-f9a0-4db7-94dc-999077287e40','SPORT DAY','2026-07-04','Building 32, 7th Floor, Student Welfare Building, Chandrakasem Rajabhat University','idol','16:15','16:20','draft',null,false,false), -- ANGeVIL✟
  ('0000000d-0000-0000-0000-0000000d2e06','00000000-0000-0000-0000-000000000001','4a7ae06f-ac32-40ad-8d10-5bc7418dd323','SPORT DAY','2026-07-04','Building 32, 7th Floor, Student Welfare Building, Chandrakasem Rajabhat University','idol','16:40','17:10','draft',null,false,false); -- HatoBito ('Hikari No Arika' 1st Performance)

-- Schedule items — Stage (each band's slot) + the shared Booth (17:40–19:50).
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
select '00000000-0000-0000-0000-000000000001'::uuid, v.eid, x.kind, x.label, x.loc,
       x.st::time, x.et::time, x.ord
from (values
  ('0000000d-0000-0000-0000-0000000d2e01'::uuid,'15:45','15:50'),  -- TERASHI
  ('0000000d-0000-0000-0000-0000000d2e02'::uuid,'16:00','16:05'),  -- LUMIN+US
  ('0000000d-0000-0000-0000-0000000d2e03'::uuid,'16:05','16:10'),  -- KŌMA
  ('0000000d-0000-0000-0000-0000000d2e04'::uuid,'16:10','16:15'),  -- Seishin Kakumei
  ('0000000d-0000-0000-0000-0000000d2e05'::uuid,'16:15','16:20'),  -- ANGeVIL✟
  ('0000000d-0000-0000-0000-0000000d2e06'::uuid,'16:40','17:10')   -- HatoBito
) as v(eid, stage_s, stage_e)
cross join lateral (values
  ('stage','Stage', null::text, v.stage_s, v.stage_e, 2),
  ('booth','Booth', null::text, '17:40',   '19:50',   3)
) as x(kind, label, loc, st, et, ord);

-- ---------------------------------------------------------------------
-- (2) Festival-wide running order (run_sequence) — the EVENT TIMETABLE.
--     Band lines for the 6 label acts link to their event above; the two GUEST acts
--     (Chocolatière, Castella) are band lines with no link.
-- ---------------------------------------------------------------------
insert into public.run_sequence
  (id, tenant_id, event_name, event_date, sort_order, title, kind, planned_start, planned_end, linked_event_id)
values
  ('0000000e-0000-0000-0000-0000000e2e01','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 1,'Register','other','10:00','10:15',null),
  ('0000000e-0000-0000-0000-0000000e2e02','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 2,'Gate Open','other','10:15','10:30',null),
  ('0000000e-0000-0000-0000-0000000e2e03','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 3,'Opening Ceremony','ceremony','10:30','10:50',null),
  ('0000000e-0000-0000-0000-0000000e2e04','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 4,'Stage of Balloon (บอลลูนด่าน)','game','10:50','11:20',null),
  ('0000000e-0000-0000-0000-0000000e2e05','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 5,'Legolas Inferno (ยิงธนู)','game','11:20','11:50',null),
  ('0000000e-0000-0000-0000-0000000e2e06','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 6,'Fire Shot (ดอดจ์บอล)','game','11:50','12:10',null),
  ('0000000e-0000-0000-0000-0000000e2e07','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 7,'A E I O U (ตุ๊กตาขยับได้)','game','12:10','12:40',null),
  ('0000000e-0000-0000-0000-0000000e2e08','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 8,'Break','break','12:40','13:40',null),
  ('0000000e-0000-0000-0000-0000000e2e09','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04', 9,'A Lot Of Tone No Basket (บาสเกตบอล)','game','13:40','14:10',null),
  ('0000000e-0000-0000-0000-0000000e2e10','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',10,'Ultra Instinct (ปิดตาตีหม้อ)','game','14:10','14:40',null),
  ('0000000e-0000-0000-0000-0000000e2e11','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',11,'Idol Musume · Pretty Derby (วิ่งเปี้ยว)','game','14:40','15:10',null),
  ('0000000e-0000-0000-0000-0000000e2e12','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',12,'Show Match · HatoBito VS KŌMA','game','15:10','15:25',null),
  ('0000000e-0000-0000-0000-0000000e2e13','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',13,'พิธีมอบรางวัล','ceremony','15:25','15:45',null),
  ('0000000e-0000-0000-0000-0000000e2e14','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',14,'TERASHI','band','15:45','15:50','0000000d-0000-0000-0000-0000000d2e01'),
  ('0000000e-0000-0000-0000-0000000e2e15','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',15,'Chocolatière (guest)','band','15:50','15:55',null),
  ('0000000e-0000-0000-0000-0000000e2e16','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',16,'Castella (guest)','band','15:55','16:00',null),
  ('0000000e-0000-0000-0000-0000000e2e17','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',17,'LUMIN+US','band','16:00','16:05','0000000d-0000-0000-0000-0000000d2e02'),
  ('0000000e-0000-0000-0000-0000000e2e18','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',18,'KŌMA','band','16:05','16:10','0000000d-0000-0000-0000-0000000d2e03'),
  ('0000000e-0000-0000-0000-0000000e2e19','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',19,'Seishin Kakumei','band','16:10','16:15','0000000d-0000-0000-0000-0000000d2e04'),
  ('0000000e-0000-0000-0000-0000000e2e20','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',20,'ANGeVIL✟','band','16:15','16:20','0000000d-0000-0000-0000-0000000d2e05'),
  ('0000000e-0000-0000-0000-0000000e2e21','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',21,'HatoBito ''Hikari No Arika'' 1st Performance','band','16:40','17:10','0000000d-0000-0000-0000-0000000d2e06'),
  ('0000000e-0000-0000-0000-0000000e2e22','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',22,'Groupshot Session','other','17:10','17:40',null),
  ('0000000e-0000-0000-0000-0000000e2e23','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',23,'Booth','other','17:40','19:50',null),
  ('0000000e-0000-0000-0000-0000000e2e24','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',24,'HatoBito Poster Sign','other','17:40','18:20',null),
  ('0000000e-0000-0000-0000-0000000e2e25','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',25,'HatoBito Lucky Draw','other','19:50','20:10',null),
  ('0000000e-0000-0000-0000-0000000e2e26','00000000-0000-0000-0000-000000000001','SPORT DAY','2026-07-04',26,'Closing Ceremony','ceremony','20:10','20:20',null);
