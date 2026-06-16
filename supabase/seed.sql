-- =====================================================================
-- CueIQ — seed data: VANTAFLARE "SUNNY SEITAN-SAI"
-- Run AFTER 0001_init.sql, in Supabase → SQL Editor. Safe to re-run.
-- =====================================================================

-- Demo workspace + group (stable IDs referenced by the new-user trigger)
insert into public.tenants (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'Capture Bomb Production', 'capture-bomb')
on conflict (id) do nothing;

insert into public.groups (id, tenant_id, name, color, exempt_from_deadline)
values ('00000000-0000-0000-0000-0000000000a1',
        '00000000-0000-0000-0000-000000000001',
        'VANTAFLARE', '#7c3aed', false)
on conflict (id) do nothing;

-- Song Library (Phase 2) — VANTAFLARE catalogue. Requires 0002_songs.sql.
delete from public.songs where group_id = '00000000-0000-0000-0000-0000000000a1';
insert into public.songs
  (tenant_id, group_id, title, file_name, duration_seconds, language, category, copyright_status) values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Flare Up','flare_up.wav',210,'en','Title','cleared'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Sunny Day Dream','sunny_day_dream.wav',222,'en','Title','cleared'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Vantablack','vantablack.wav',200,'en','B-side','cleared'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Kimi to Seitansai','kimi_to_seitansai.wav',240,'jp','Cover','pending'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Sunny Smile (Solo)','sunny_smile_solo.wav',220,'en','Solo','cleared'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Eternal Flare','eternal_flare.wav',235,'en','Title','cleared'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Forever Vanta (Encore)','forever_vanta.wav',250,'en','Encore','cleared');

-- Reset demo content so this file is safe to re-run
delete from public.members where group_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.events  where id = '00000000-0000-0000-0000-0000000000e1'; -- cascades children

-- Members (with mic numbers)
insert into public.members (tenant_id, group_id, name, nickname, mic_number, sort_order) values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Sunny','Sunny',1,1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Mlint','Mlint',2,2),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Aira','Aira',3,3),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Yuki','Yuki',4,4),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Nano','Nano',5,5),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','Koko','Koko',6,6);

-- Event
insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes)
values
  ('00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-0000000000a1',
   'VANTAFLARE SUNNY SEITAN-SAI',
   '2026-07-12', 'Lot of Live (Bangkok)', 'idol',
   '18:00', '18:50', 'in_progress',
   'SUNNY 生誕祭 — birthday celebration stage. Single-member SEITAN-SAI.');

-- Schedule
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, notes, sort_order)
values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','on_location','ถึงสถานที่','Lot of Live','14:00',null,'ทีมงาน + สมาชิกพร้อมกัน',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','dressing_room','ห้องแต่งตัว','Backstage Room 2','14:15',null,'แต่งหน้า/ทำผม',2),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','sound_check','Sound Check','Main Stage','16:00','16:30','เช็คไมค์ 1-6 + handheld',3),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','stb','Stand By (STB)','Side Stage','17:45',null,'เข้าจุด standby',4),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','stage','Stage Round 1','Main Stage','18:00','18:45','โชว์หลัก',5),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','booth','High-touch + แฟนไซน์','Booth A','19:00','19:45','รอบกิจกรรมแฟน',6),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','photo','Group Photo Session','Photo Wall','19:50','20:10','ถ่ายรูปรวม',7);

-- Setlist (durations in seconds; mic_slots = per-song mic -> member)
insert into public.setlist_items
  (tenant_id, event_id, kind, title, duration_seconds,
   buffer_before_seconds, buffer_after_seconds, mic_slots, notes, sort_order)
values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','se','OPENING SE + VTR',30,0,5,
 '[]','เรียกชื่อสมาชิก, ไฟค่อยขึ้น',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Flare Up',210,5,3,
 '[{"mic":"1","member":"Sunny"},{"mic":"2","member":"Mlint"},{"mic":"3","member":"Aira"},{"mic":"4","member":"Yuki"},{"mic":"5","member":"Nano"},{"mic":"6","member":"Koko"}]',
 'เปิดวง เต็มวง',2),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Sunny Day Dream',222,3,3,
 '[{"mic":"1","member":"Sunny"},{"mic":"2","member":"Mlint"},{"mic":"3","member":"Aira"},{"mic":"4","member":"Yuki"},{"mic":"5","member":"Nano"},{"mic":"6","member":"Koko"}]',
 'center: Sunny',3),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','mc','MC 1 — ทักทาย',180,3,3,
 '[{"mic":"7","member":"Sunny"},{"mic":"8","member":"Mlint"}]','handheld 2 ตัว',4),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Vantablack',200,3,3,
 '[{"mic":"1","member":"Sunny"},{"mic":"2","member":"Mlint"},{"mic":"3","member":"Aira"},{"mic":"4","member":"Yuki"},{"mic":"5","member":"Nano"},{"mic":"6","member":"Koko"}]',
 'เพลงเต้น',5),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Kimi to Seitansai',240,3,5,
 '[{"mic":"1","member":"Sunny"},{"mic":"2","member":"Mlint"},{"mic":"3","member":"Aira"},{"mic":"4","member":"Yuki"},{"mic":"5","member":"Nano"},{"mic":"6","member":"Koko"}]',
 'เพลงวันเกิด — โปรย confetti ท้ายเพลง',6),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','interlude','VTR — Sunny History',120,3,3,
 '[]','ฉาย VTR, เปลี่ยนชุด',7),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','mc','MC 2 — Birthday Celebration',360,3,3,
 '[{"mic":"7","member":"Sunny"},{"mic":"8","member":"Mlint"}]','เค้ก + เซอร์ไพรส์ + อ่านจดหมาย',8),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Sunny Smile (Solo)',220,3,3,
 '[{"mic":"1","member":"Sunny"}]','โซโล่ Sunny',9),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Eternal Flare',235,3,3,
 '[{"mic":"1","member":"Sunny"},{"mic":"2","member":"Mlint"},{"mic":"3","member":"Aira"},{"mic":"4","member":"Yuki"},{"mic":"5","member":"Nano"},{"mic":"6","member":"Koko"}]',
 'เต็มวง',10),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','mc','MC 3 — ขอบคุณ + ประกาศ',150,3,3,
 '[{"mic":"7","member":"Sunny"}]','ประกาศงานหน้า',11),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1','song','Forever Vanta (Encore)',250,5,0,
 '[{"mic":"1","member":"Sunny"},{"mic":"2","member":"Mlint"},{"mic":"3","member":"Aira"},{"mic":"4","member":"Yuki"},{"mic":"5","member":"Nano"},{"mic":"6","member":"Koko"}]',
 'อังกอร์ปิดโชว์',12);

-- Mic map (base). mic 7 demonstrates rotation: 1 number -> several holders + order.
insert into public.mic_assignments (tenant_id, event_id, mic_number, holder_name, order_index) values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',1,'Sunny',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',2,'Mlint',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',3,'Aira',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',4,'Yuki',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',5,'Nano',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',6,'Koko',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',7,'Sunny',1),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',7,'Aira',2),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',7,'Yuki',3);
