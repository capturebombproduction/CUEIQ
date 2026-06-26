-- =====================================================================
-- CueIQ — run_sequence ONLY for "ANGeVIL✟ PHASE 2.0: debut stage" (2026-06-27).
--   ADDITIVE & SAFE: touches ONLY run_sequence (it was empty). Does NOT delete or
--   re-create the events — so KŌMA's & Seishin's already-entered setlists/mics are
--   untouched. (Re-running the full festival seed_angevil_phase2.sql WOULD wipe those
--   via the events cascade — do NOT do that.)
--   Covers the 7 LABEL-band stage slots in time order (linked to their live events).
--   Guest acts are NOT in the system (intentionally unseeded) → the gaps between label
--   slots are where guests play. Add them later if the organiser timetable arrives.
--   Idempotent: delete-by-name first, fixed UUIDs.
-- =====================================================================

delete from public.run_sequence where event_name = 'ANGeVIL✟ PHASE 2.0: debut stage';

insert into public.run_sequence
  (id, tenant_id, event_name, event_date, sort_order, title, kind, planned_start, planned_end, linked_event_id)
values
  ('0000001a-0000-0000-0000-0000001a2e01','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',1,'HatoBito','band','11:50','12:10','0000000a-0000-0000-0000-0000000a2e01'),
  ('0000001a-0000-0000-0000-0000001a2e02','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',2,'TERASHI','band','14:00','14:20','0000000a-0000-0000-0000-0000000a2e03'),
  ('0000001a-0000-0000-0000-0000001a2e03','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',3,'LUMIN+US','band','14:20','14:40','0000000a-0000-0000-0000-0000000a2e04'),
  ('0000001a-0000-0000-0000-0000001a2e04','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',4,'KŌMA','band','14:40','15:00','0000000a-0000-0000-0000-0000000a2e05'),
  ('0000001a-0000-0000-0000-0000001a2e05','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',5,'Seishin Kakumei','band','15:00','15:20','0000000a-0000-0000-0000-0000000a2e06'),
  ('0000001a-0000-0000-0000-0000001a2e06','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',6,'HatoBito','band','15:30','15:50','0000000a-0000-0000-0000-0000000a2e02'),
  ('0000001a-0000-0000-0000-0000001a2e07','00000000-0000-0000-0000-000000000001','ANGeVIL✟ PHASE 2.0: debut stage','2026-06-27',7,'ANGeVIL✟ (headliner)','band','16:40','17:40','0000000a-0000-0000-0000-0000000a2e07');
