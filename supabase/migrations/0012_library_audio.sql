-- =====================================================================
-- CueIQ — Library-centric audio
--
-- Audio now lives on the SONG in the library (upload once, reuse across events).
-- Setlist items LINK to a song; Live Mode plays the linked song's file. A quick
-- ad-hoc upload from Live Mode creates a TEMPORARY song (audio_expires_at = +3d)
-- that self-cleans, so the library doesn't fill with one-off files.
--
-- The bytes live in Cloudflare R2 (key tenant/group/songs/<song_id>-<rand>.<ext>);
-- here we only keep the pointer + display name, same as setlist_items did.
--
-- Run via: npm run migrate supabase/migrations/0012_library_audio.sql  (safe to re-run)
-- =====================================================================

-- 1) songs own their audio (+ optional temp-expiry for ad-hoc uploads).
alter table public.songs add column if not exists audio_path text;
alter table public.songs add column if not exists audio_name text;
-- null = permanent (a song you prepared); a timestamp = temporary, auto-cleaned
-- once it passes (ad-hoc uploads from Live Mode get now()+3 days).
alter table public.songs add column if not exists audio_expires_at timestamptz;

-- 2) setlist items LINK to a library song (the audio source). on delete set null
--    so deleting a song doesn't delete the run-sheet row — it just loses the file
--    (the library delete flow warns "used in X events" first).
alter table public.setlist_items
  add column if not exists song_id uuid references public.songs(id) on delete set null;

create index if not exists idx_setlist_items_song on public.setlist_items(song_id);
create index if not exists idx_songs_audio_expires on public.songs(audio_expires_at)
  where audio_expires_at is not null;
