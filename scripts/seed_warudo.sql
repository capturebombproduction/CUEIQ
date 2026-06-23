-- =====================================================================
-- CueIQ — SKELETON seed: "WARUDO SHOW"
--   Date 2026-07-05 (Sun) · The Street Ratchada 5th Floor.
--   No timetable yet — this is a placeholder so every label band sees the show on
--   their calendar. All 8 label bands seeded as DRAFT with NO stage/booth times;
--   fill show_start/hard_out + schedule_items per band once the running order is out
--   (re-running this replaces the skeleton; it does NOT clobber times added later
--   only if you stop re-running it — so once real times go in, don't re-run).
--   INSERT-only (delete-by-name first); no UPDATE, safe to run while bands use prod.
-- =====================================================================

delete from public.events where name = 'WARUDO SHOW';

insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
values
  ('0000000c-0000-0000-0000-0000000c2e01','00000000-0000-0000-0000-000000000001','4bc8f4ca-f9a0-4db7-94dc-999077287e40','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- ANGeVIL✟
  ('0000000c-0000-0000-0000-0000000c2e02','00000000-0000-0000-0000-000000000001','4a7ae06f-ac32-40ad-8d10-5bc7418dd323','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- HatoBito
  ('0000000c-0000-0000-0000-0000000c2e03','00000000-0000-0000-0000-000000000001','cefc2fec-f36c-4af8-9dfd-5584aa8ba06f','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- KNIGHT✠RES
  ('0000000c-0000-0000-0000-0000000c2e04','00000000-0000-0000-0000-000000000001','9fa66a5c-5be6-4c15-a4a7-67a51f80f066','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- KŌMA
  ('0000000c-0000-0000-0000-0000000c2e05','00000000-0000-0000-0000-000000000001','d533b546-edf5-427e-a31f-8f32399aeeac','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- LUMIN+US
  ('0000000c-0000-0000-0000-0000000c2e06','00000000-0000-0000-0000-000000000001','c8788874-d6f9-41bd-a675-5d7628a15881','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- Seishin Kakumei
  ('0000000c-0000-0000-0000-0000000c2e07','00000000-0000-0000-0000-000000000001','cfe82737-77ec-4c03-8cd8-858fbfb86a97','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false), -- TERASHI
  ('0000000c-0000-0000-0000-0000000c2e08','00000000-0000-0000-0000-000000000001','bf6ace31-eed8-4b84-bef3-7b75d45d101e','WARUDO SHOW','2026-07-05','The Street Ratchada 5th Floor','idol',null,null,'draft',null,false,false); -- V!NX
