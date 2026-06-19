-- =====================================================================
-- CueIQ — fix: raise the event-audio per-file size limit
--
-- Real tracks are WAV (27–88 MB), not MP3. The original 50 MB bucket limit
-- (0004) would reject most of them. Raise to 200 MB (covers long WAV + FLAC).
-- (NOTE: Supabase FREE plan may also enforce a project-wide ~50 MB upload cap —
-- if uploads still fail, either use a compressed format or upgrade to Pro.)
--
-- Run via: npm run migrate supabase/migrations/0011_audio_size_limit.sql
-- =====================================================================

update storage.buckets
set file_size_limit = 209715200  -- 200 MB
where id = 'event-audio';
