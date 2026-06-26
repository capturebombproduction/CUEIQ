-- =====================================================================
-- CueIQ — run_sequence ONLY for "Pim's Graduation Ceremony" (2026-06-28).
--   ADDITIVE & SAFE: touches ONLY run_sequence (it was empty). Does NOT delete or
--   re-create the events — so Seishin's already-entered setlist is untouched.
--   (Re-running the full seed_pims.sql WOULD wipe it via the events cascade.)
--   Covers the 4 LABEL-band stage slots in time order (linked to their live events).
--   Guest acts are unseeded → gaps are theirs; add later if a full timetable arrives.
--   Idempotent: delete-by-name first, fixed UUIDs.
-- =====================================================================

delete from public.run_sequence where event_name = 'Pim''s Graduation Ceremony';

insert into public.run_sequence
  (id, tenant_id, event_name, event_date, sort_order, title, kind, planned_start, planned_end, linked_event_id)
values
  ('0000001b-0000-0000-0000-0000001b2e01','00000000-0000-0000-0000-000000000001','Pim''s Graduation Ceremony','2026-06-28',1,'LUMIN+US','band','12:00','12:20','0000000b-0000-0000-0000-0000000b2e01'),
  ('0000001b-0000-0000-0000-0000001b2e02','00000000-0000-0000-0000-000000000001','Pim''s Graduation Ceremony','2026-06-28',2,'KŌMA','band','12:20','12:40','0000000b-0000-0000-0000-0000000b2e02'),
  ('0000001b-0000-0000-0000-0000001b2e03','00000000-0000-0000-0000-000000000001','Pim''s Graduation Ceremony','2026-06-28',3,'Seishin Kakumei','band','12:40','13:00','0000000b-0000-0000-0000-0000000b2e03'),
  ('0000001b-0000-0000-0000-0000001b2e04','00000000-0000-0000-0000-000000000001','Pim''s Graduation Ceremony','2026-06-28',4,'HatoBito','band','13:00','13:20','0000000b-0000-0000-0000-0000000b2e04');
