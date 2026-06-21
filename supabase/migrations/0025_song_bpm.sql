-- 0025_song_bpm.sql
-- Practice Mode Slice 4: per-song tempo for the metronome. Optional (null = unset).
-- RLS unchanged — bpm rides the existing songs policies (write = the band's Ar/admin
-- via songs_update; a column guard already limits approvers to copyright_status).
alter table public.songs
  add column if not exists bpm int;
