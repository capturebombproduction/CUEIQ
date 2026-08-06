-- 0041_practice_logs_runs_band_scope.sql
-- Residue from 0038's C13 fix: that migration rescoped practice_songs and
-- song_markers writes from can_view_group to band-membership-or-editor (a CEO —
-- read-only by the 0016 role model — could otherwise curate every band's practice
-- list), but two sibling tables in the SAME feature kept the old gate:
--
--   practice_logs_insert (0024, ~42-47) — a label-wide viewer (ceo, label_staff)
--     could author a 'shared' journal entry in any band's practice room.
--   practice_runs_insert (0024, ~79-81) — same account could write auto-log rows
--     (song/seconds/speed) into any band's practice history.
--
-- can_view_group is true for is_label_wide roles by design (they see everything);
-- the write boundary for THIS feature is the band itself, same as 0038 (2). SELECT
-- is untouched on both tables. practice_logs_update/_delete and practice_runs'
-- (nonexistent) update/delete are NOT touched: update/delete already gate on
-- `author_id = auth.uid() or can_edit_group(group_id)`, which a label-wide-only
-- viewer can never satisfy, so they carry no can_view_group-only gate to close.
--
-- Additive + idempotent. Safe to re-run. Run with:
--   npm run migrate

-- ---------------------------------------------------------------------
-- practice_logs_insert — author your own row, but only in a band you belong to
-- ---------------------------------------------------------------------
-- Mirrors 0038's practice_songs_insert exactly: editor (admin / the band's Ar) OR
-- anyone holding a group_roles row for that band (its members). Staff-visibility
-- notes still require an editor, same as before.
drop policy if exists practice_logs_insert on public.practice_logs;
create policy practice_logs_insert on public.practice_logs
  for insert with check (
    author_id = auth.uid()
    and (
      public.can_edit_group(group_id)
      or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
    )
    and (visibility = 'shared' or public.can_edit_group(group_id))
  );

-- ---------------------------------------------------------------------
-- practice_runs_insert — same band-membership-or-editor boundary
-- ---------------------------------------------------------------------
drop policy if exists practice_runs_insert on public.practice_runs;
create policy practice_runs_insert on public.practice_runs
  for insert with check (
    created_by = auth.uid()
    and (
      public.can_edit_group(group_id)
      or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
    )
  );
