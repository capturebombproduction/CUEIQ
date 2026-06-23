-- =====================================================================
-- CueIQ — REAL seed: "Pim's Graduation Ceremony"
--   Date 2026-06-28 (Sun) · Phenix Pratunam.
--   Label "A Lot Of Tone" acts ONLY (4): LUMIN+US, KŌMA, Seishin Kakumei,
--   HatoBito. One shared event name so the Overview collapses them into a single
--   festival header (band per row). Guest acts (KYLINZ, ZYN, Myujikku Majo,
--   Neko Pon!, PEACH YOU, STARRY☆NITE, NIKKO NIKKO, The Glass Girls) are NOT label
--   bands → intentionally not seeded.
--   hard_out_time = the band's STAGE end (when it must be OFF stage) — it drives the
--   event page's "Stage" line + the show-flow "Remaining" countdown. The 14:30–16:00
--   booth window lives in the booth schedule_item, NOT in hard_out. (Learned from the
--   ANGeVIL seed, where hard_out was wrongly set to the booth end and the event page
--   then showed the stage running till booth-close.)
--   INSERT-only (delete-by-name first for idempotency); no UPDATE, so it never trips
--   events_guard_update and is safe to run while bands use prod.
--   Idempotent: re-running replaces this festival cleanly (fixed UUIDs + delete-first).
-- =====================================================================

delete from public.events where name = 'Pim''s Graduation Ceremony';

insert into public.events
  (id, tenant_id, group_id, name, event_date, venue, event_type,
   show_start_time, hard_out_time, status, notes, is_template, is_practice)
values
  ('0000000b-0000-0000-0000-0000000b2e01','00000000-0000-0000-0000-000000000001','d533b546-edf5-427e-a31f-8f32399aeeac','Pim''s Graduation Ceremony','2026-06-28','Phenix Pratunam','idol','12:00','12:20','draft',null,false,false),
  ('0000000b-0000-0000-0000-0000000b2e02','00000000-0000-0000-0000-000000000001','9fa66a5c-5be6-4c15-a4a7-67a51f80f066','Pim''s Graduation Ceremony','2026-06-28','Phenix Pratunam','idol','12:20','12:40','draft',null,false,false),
  ('0000000b-0000-0000-0000-0000000b2e03','00000000-0000-0000-0000-000000000001','c8788874-d6f9-41bd-a675-5d7628a15881','Pim''s Graduation Ceremony','2026-06-28','Phenix Pratunam','idol','12:40','13:00','draft',null,false,false),
  ('0000000b-0000-0000-0000-0000000b2e04','00000000-0000-0000-0000-000000000001','4a7ae06f-ac32-40ad-8d10-5bc7418dd323','Pim''s Graduation Ceremony','2026-06-28','Phenix Pratunam','idol','13:00','13:20','draft',null,false,false);

-- Schedule items — Stage (on-stage window) + Booth (14:30–16:00, M Floor) per act.
insert into public.schedule_items
  (tenant_id, event_id, kind, label, location, start_time, end_time, sort_order)
select '00000000-0000-0000-0000-000000000001'::uuid, v.eid, x.kind, x.label, x.loc,
       x.st::time, x.et::time, x.ord
from (values
  ('0000000b-0000-0000-0000-0000000b2e01'::uuid,'12:00','12:20'),  -- LUMIN+US
  ('0000000b-0000-0000-0000-0000000b2e02'::uuid,'12:20','12:40'),  -- KŌMA
  ('0000000b-0000-0000-0000-0000000b2e03'::uuid,'12:40','13:00'),  -- Seishin Kakumei
  ('0000000b-0000-0000-0000-0000000b2e04'::uuid,'13:00','13:20')   -- HatoBito
) as v(eid, stage_s, stage_e)
cross join lateral (values
  ('stage','Stage', null::text,      v.stage_s, v.stage_e, 2),
  ('booth','Booth', 'M Floor'::text, '14:30',   '16:00',   3)
) as x(kind, label, loc, st, et, ord);
