-- =====================================================================
-- CueIQ — Phase 2: Online audio files (Supabase Storage)
--
-- Live Mode audio used to live only on the device that picked the file
-- (IndexedDB). This moves the bytes into a PRIVATE Storage bucket so a file
-- uploaded on one device plays on every logged-in device of the same tenant,
-- survives a reinstall, and can be deleted. IndexedDB stays as a local cache.
--
-- Path convention:  <tenant_id>/<event_id>/<item_id>-<rand>.<ext>
-- so the FIRST folder segment is always the tenant id → RLS keys off it.
--
-- Run in Supabase → SQL Editor (as the project owner). Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) setlist_items gains a pointer to its audio object (path + display name).
--    The bytes live in Storage; here we only keep the key + original filename.
--    (RLS + grants for setlist_items already exist from 0001 — UPDATE covers these.)
-- ---------------------------------------------------------------------
alter table public.setlist_items add column if not exists audio_path text;
alter table public.setlist_items add column if not exists audio_name text;

-- ---------------------------------------------------------------------
-- 2) Private bucket. public=false → no anonymous URLs; reads go through the
--    authenticated API (download / signed URL) and are gated by the policies below.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('event-audio', 'event-audio', false, 52428800)  -- 50 MB/file
on conflict (id) do update set public = false;

-- ---------------------------------------------------------------------
-- 3) Storage RLS — same shape as the domain tables: members read, editors
--    write/delete. The tenant is the first path segment; reuse the SECURITY
--    DEFINER helpers from 0001. Policies are scoped to this bucket only, so the
--    ::uuid cast never sees a foreign path.
-- ---------------------------------------------------------------------
drop policy if exists event_audio_select on storage.objects;
create policy event_audio_select on storage.objects
  for select to authenticated using (
    bucket_id = 'event-audio'
    and public.is_tenant_member( ((storage.foldername(name))[1])::uuid )
  );

drop policy if exists event_audio_insert on storage.objects;
create policy event_audio_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'event-audio'
    and public.can_edit_tenant( ((storage.foldername(name))[1])::uuid )
  );

drop policy if exists event_audio_update on storage.objects;
create policy event_audio_update on storage.objects
  for update to authenticated using (
    bucket_id = 'event-audio'
    and public.can_edit_tenant( ((storage.foldername(name))[1])::uuid )
  ) with check (
    bucket_id = 'event-audio'
    and public.can_edit_tenant( ((storage.foldername(name))[1])::uuid )
  );

drop policy if exists event_audio_delete on storage.objects;
create policy event_audio_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'event-audio'
    and public.can_edit_tenant( ((storage.foldername(name))[1])::uuid )
  );
