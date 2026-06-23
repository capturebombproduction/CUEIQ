-- =====================================================================
-- CueIQ — fix: restore "Celebrate 3rd Year with NIKKO NIKKO" as Seishin's
-- TEMPLATE (the real event the old clone was derived from), and drop the
-- redundant clone "แม่แบบ (NIKKO)". Net: every band still has exactly ONE
-- template; Seishin's is now the real event instead of the clone.
-- Songs survive in the library — only the setlist LINKS are rebuilt here.
-- Idempotent (fixed ids + delete-first).
-- =====================================================================

-- 1) Drop the redundant clone.
delete from public.events where id = 'a959484f-f497-40e3-b8e6-e96059a4b629'; -- แม่แบบ (NIKKO)

-- 2) Restore the real event, flagged is_template=true so it IS Seishin's
--    "สร้างจากแม่แบบ" source (hidden from Overview/Dashboard like every template).
delete from public.events where id = 'd3a2a9b0-195d-4415-beab-0a1abdd3db21';
insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
values
  ('d3a2a9b0-195d-4415-beab-0a1abdd3db21','00000000-0000-0000-0000-000000000001',
   'c8788874-d6f9-41bd-a675-5d7628a15881','Celebrate 3rd Year with NIKKO NIKKO',
   '2026-06-20','The Street Ratchada','idol','11:25','11:45','approved',
   'เช้าแล้ว เช้าอยู่ เช้าตลอดไป', true, false);

-- 3) Schedule items — exactly as backed up before the delete.
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
values
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','on_location',  null,        'The Street Ratchada','10:00','13:30',1),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','dressing_room',null,        'รออัพเดต',           '10:00', null, 2),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','stb',          null,        'Back stage',         '11:10', null, 5),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','stage',        null,        'Main stage ชั้น 5',  '11:25','11:45',6),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','booth',        null,        'หน้าฮออล์ Booth F',  '12:00','13:30',7),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','photo',        'หลังจบบุ',  null,                 '13:40', null, 8);

-- 4) Setlist — 5 library songs relinked by song_id (titles + order from backup).
insert into public.setlist_items
  (tenant_id, event_id, kind, title, song_id, sort_order)
values
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','song','[SYSTEM_BOOT] SE (Overture)',    '3c828054-4c59-4fec-80c8-7be210b6d110',1),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','song','Eve of the Revolution',          'de371037-34b7-4af6-a173-daf68cd02cb3',2),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','song','I Am Who I Am',                  '087c5859-d57d-4fbf-9c61-0c34ba434e99',3),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','song','Overclock Strike',               'b4357b0a-c373-4654-82b7-8ca05b8b21f2',4),
  ('00000000-0000-0000-0000-000000000001','d3a2a9b0-195d-4415-beab-0a1abdd3db21','song','Out Of Control (Instrumental)',  '3e7bb419-01e8-46d9-8b10-4ad668281040',5);
