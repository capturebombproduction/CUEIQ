-- 0031_song_markers_member_write.sql
-- Practice Mode: let any band MEMBER manage section markers (Intro/Verse/Hook/…),
-- not just the Ar — members practice on their own / at home and mark their own
-- sections. Markers are a band practice aid, so the same member-writable model as
-- practice_songs / practice_runs (write = can_view_group). Read was already open.
-- (Song BPM stays Ar-only — it lives on the guarded songs table, not here.)
drop policy if exists song_markers_write on public.song_markers;
create policy song_markers_write on public.song_markers
  for all using (public.can_view_group(group_id))
  with check (public.can_view_group(group_id));

-- (table grant already exists from 0023/0026; re-assert for safety — RLS ≠ GRANT)
grant select, insert, update, delete on public.song_markers to authenticated;
