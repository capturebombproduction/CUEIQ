-- 0036 — at most ONE 'photo' (ถ่ายรูป) schedule_item per event.
--
-- Why: bands/staff filled the photo call-time from several devices at once via the
-- Overview inline cell and the schedule editor, leaving 2–3 conflicting photo rows
-- per event; the Overview then showed an arbitrary one (cleaned up by hand in
-- scripts/seed_angevil_gd_fix.sql). A partial UNIQUE index makes a second photo row
-- impossible going forward — the only race-proof ("ถาวร") guarantee. The app's photo
-- write paths catch the unique violation (23505) and update the existing row instead,
-- so the user's value is still saved.
--
-- Safe to create now: verified zero events hold >1 photo row (incl. templates).
-- Other 'kind's (on_location/stb/other/…) can still repeat — only 'photo' is capped.

create unique index if not exists schedule_items_one_photo_per_event
  on public.schedule_items (event_id)
  where kind = 'photo';
