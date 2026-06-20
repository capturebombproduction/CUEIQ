-- =====================================================================
-- CueIQ — Realtime on songs (future-proofing)
--
-- NOTE: Live Mode's real-time library-audio update currently uses a BROADCAST
-- channel (`songs:<groupId>`), because RLS-gated postgres_changes don't deliver
-- with the publishable anon key. This adds songs to the realtime publication so
-- postgres_changes WOULD work if the project later switches to the JWT anon key
-- — harmless + zero-cost until then. Safe to keep.
--
-- Run via: npm run migrate supabase/migrations/0013_songs_realtime.sql  (safe to re-run)
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'songs'
  ) then
    alter publication supabase_realtime add table public.songs;
  end if;
end $$;
