-- =====================================================================
-- CueIQ — REAL seed: "WARUDO SHOW"  (organiser-run idol festival)
--   Date 2026-07-05 (Sun) · The Street Ratchada 5th Floor.
--   Replaces the earlier skeleton (8 placeholder draft bands, no times) now that
--   the organiser timetable is out. Of the 8 label bands, only FIVE are on the
--   WARUDO line-up — HatoBito, KŌMA, Seishin Kakumei, LUMIN+US, ANGeVIL✟. The
--   other three (KNIGHT✠RES, TERASHI, V!NX) do NOT perform, so the delete-by-name
--   below drops their stale skeleton events (WARUDO leaves their calendars).
--
--   Two parts (mirrors scripts/seed_sportday.sql, the established template):
--   (1) per-band EVENTS for the 5 label acts — each with its STAGE slot
--       (show_start/hard_out = on/off-stage) + its own staggered BOOTH window as a
--       schedule_item (booth letter in the label). hard_out_time = STAGE end, NOT
--       booth end (booth lives only in the booth schedule_item — ANGeVIL/SPORT DAY
--       lesson).
--   (2) the festival-wide RUNNING ORDER (run_sequence — Event Live Mode) = a faithful
--       copy of the stage TIMETABLE: register/gate, all 31 stage acts in time order
--       (the 5 label acts link to their event above; every guest act — incl. the
--       Japanese headliner Kyushu Girls Wing — is a band line with NO event link),
--       and the closing Kyushu Girls Wing ONE-MAN LIVE.
--   INSERT-only (delete-by-name first for idempotency); no UPDATE, so it never trips
--   events_guard_update and is safe to run while bands use prod. Re-running replaces
--   this festival cleanly (fixed UUIDs + delete-first). schedule_items cascade off
--   the event delete.
-- =====================================================================

delete from public.run_sequence where event_name = 'WARUDO SHOW';
delete from public.events       where name       = 'WARUDO SHOW';

-- ---------------------------------------------------------------------
-- (1) Per-band events — the 5 label acts on the WARUDO stage.
--     Reuses the skeleton's fixed event UUIDs for the bands that stayed.
-- ---------------------------------------------------------------------
insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
values
  ('0000000c-0000-0000-0000-0000000c2e02','00000000-0000-0000-0000-000000000001','4a7ae06f-ac32-40ad-8d10-5bc7418dd323','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol','11:55','12:10','draft',null,false,false), -- HatoBito
  ('0000000c-0000-0000-0000-0000000c2e04','00000000-0000-0000-0000-000000000001','9fa66a5c-5be6-4c15-a4a7-67a51f80f066','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol','12:10','12:25','draft',null,false,false), -- KŌMA
  ('0000000c-0000-0000-0000-0000000c2e06','00000000-0000-0000-0000-000000000001','c8788874-d6f9-41bd-a675-5d7628a15881','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol','15:40','15:55','draft',null,false,false), -- Seishin Kakumei
  ('0000000c-0000-0000-0000-0000000c2e05','00000000-0000-0000-0000-000000000001','d533b546-edf5-427e-a31f-8f32399aeeac','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol','16:25','16:40','draft',null,false,false), -- LUMIN+US
  ('0000000c-0000-0000-0000-0000000c2e01','00000000-0000-0000-0000-000000000001','4bc8f4ca-f9a0-4db7-94dc-999077287e40','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol','17:15','17:30','draft',null,false,false); -- ANGeVIL✟

-- Schedule items — Stage (the band's on/off-stage slot) + its staggered Booth window.
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
select '00000000-0000-0000-0000-000000000001'::uuid, v.eid, x.kind, x.label, x.loc,
       x.st::time, x.et::time, x.ord
from (values
  ('0000000c-0000-0000-0000-0000000c2e02'::uuid,'11:55','12:10','Booth A','12:20','13:50'),  -- HatoBito
  ('0000000c-0000-0000-0000-0000000c2e04'::uuid,'12:10','12:25','Booth B','12:35','14:05'),  -- KŌMA
  ('0000000c-0000-0000-0000-0000000c2e06'::uuid,'15:40','15:55','Booth C','16:05','17:35'),  -- Seishin Kakumei
  ('0000000c-0000-0000-0000-0000000c2e05'::uuid,'16:25','16:40','Booth F','16:50','18:20'),  -- LUMIN+US
  ('0000000c-0000-0000-0000-0000000c2e01'::uuid,'17:15','17:30','Booth C','17:40','19:10')   -- ANGeVIL✟
) as v(eid, stage_s, stage_e, booth_label, booth_s, booth_e)
cross join lateral (values
  ('stage','Stage',       null::text, v.stage_s, v.stage_e, 2),
  ('booth', v.booth_label, null::text, v.booth_s, v.booth_e, 3)
) as x(kind, label, loc, st, et, ord);

-- ---------------------------------------------------------------------
-- (2) Festival-wide running order (run_sequence) — the stage TIMETABLE.
--     Label acts link to their event above; every guest act is an unlinked band line.
-- ---------------------------------------------------------------------
insert into public.run_sequence
  (id, tenant_id, event_name, event_date, sort_order, title, kind, planned_start, planned_end, linked_event_id)
values
  ('0000000f-0000-0000-0000-0000000f2e01','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 1,'Register','other','10:00','10:10',null),
  ('0000000f-0000-0000-0000-0000000f2e02','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 2,'Gate Open','other','10:10','10:20',null),
  ('0000000f-0000-0000-0000-0000000f2e03','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 3,'LoliLolitia','band','10:20','10:35',null),
  ('0000000f-0000-0000-0000-0000000f2e04','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 4,'Myujikku Majo','band','10:35','10:50',null),
  ('0000000f-0000-0000-0000-0000000f2e05','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 5,'ZYN','band','10:50','11:05',null),
  ('0000000f-0000-0000-0000-0000000f2e06','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 6,'KYLINZ','band','11:05','11:20',null),
  ('0000000f-0000-0000-0000-0000000f2e07','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 7,'Kagekishi','band','11:20','11:35',null),
  ('0000000f-0000-0000-0000-0000000f2e08','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 8,'KIRAKIRA♡ROMANCE','band','11:40','11:55',null),
  ('0000000f-0000-0000-0000-0000000f2e09','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05', 9,'HatoBito','band','11:55','12:10','0000000c-0000-0000-0000-0000000c2e02'),
  ('0000000f-0000-0000-0000-0000000f2e10','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',10,'KŌMA','band','12:10','12:25','0000000c-0000-0000-0000-0000000c2e04'),
  ('0000000f-0000-0000-0000-0000000f2e11','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',11,'Kyushu Girls Wing','band','12:25','12:40',null),
  ('0000000f-0000-0000-0000-0000000f2e12','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',12,'Yami Yami','band','12:40','12:55',null),
  ('0000000f-0000-0000-0000-0000000f2e13','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',13,'Akira Kuro','band','13:00','13:15',null),
  ('0000000f-0000-0000-0000-0000000f2e14','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',14,'Nox:off','band','13:15','13:30',null),
  ('0000000f-0000-0000-0000-0000000f2e15','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',15,'Neko Pon!','band','13:30','13:45',null),
  ('0000000f-0000-0000-0000-0000000f2e16','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',16,'PEACH YOU','band','13:45','14:00',null),
  ('0000000f-0000-0000-0000-0000000f2e17','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',17,'STARRY☆NITE','band','14:00','14:15',null),
  ('0000000f-0000-0000-0000-0000000f2e18','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',18,'NIKKO NIKKO','band','14:20','14:35',null),
  ('0000000f-0000-0000-0000-0000000f2e19','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',19,'The Glass Girls','band','14:35','14:50',null),
  ('0000000f-0000-0000-0000-0000000f2e20','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',20,'Akibar','band','14:50','15:05',null),
  ('0000000f-0000-0000-0000-0000000f2e21','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',21,'Chocolatière','band','15:05','15:20',null),
  ('0000000f-0000-0000-0000-0000000f2e22','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',22,'Dream:on','band','15:20','15:35',null),
  ('0000000f-0000-0000-0000-0000000f2e23','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',23,'Seishin Kakumei','band','15:40','15:55','0000000c-0000-0000-0000-0000000c2e06'),
  ('0000000f-0000-0000-0000-0000000f2e24','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',24,'Mirai Mirai','band','15:55','16:10',null),
  ('0000000f-0000-0000-0000-0000000f2e25','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',25,'SILVER LINING','band','16:10','16:25',null),
  ('0000000f-0000-0000-0000-0000000f2e26','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',26,'LUMIN+US','band','16:25','16:40','0000000c-0000-0000-0000-0000000c2e05'),
  ('0000000f-0000-0000-0000-0000000f2e27','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',27,'Castella','band','16:40','16:55',null),
  ('0000000f-0000-0000-0000-0000000f2e28','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',28,'Sora! Sora!','band','17:00','17:15',null),
  ('0000000f-0000-0000-0000-0000000f2e29','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',29,'ANGeVIL✟','band','17:15','17:30','0000000c-0000-0000-0000-0000000c2e01'),
  ('0000000f-0000-0000-0000-0000000f2e30','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',30,'Kakigori Project','band','17:30','17:45',null),
  ('0000000f-0000-0000-0000-0000000f2e31','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',31,'Rina Izuta','band','17:45','18:00',null),
  ('0000000f-0000-0000-0000-0000000f2e32','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',32,'Mahnmook','band','18:00','18:15',null),
  ('0000000f-0000-0000-0000-0000000f2e33','00000000-0000-0000-0000-000000000001','WARUDO SHOW','2026-07-05',33,'Kyushu Girls Wing — ONE-MAN LIVE','band','19:00','20:30',null);
