-- 0047_song_back_to_review.sql
-- พี่ 2026-10-07: a song that passed copyright review and is then changed by the band -
-- a new audio file, or a new title - goes back to "รอตรวจ" (pending), and the admins
-- are told (the client sends notify "song_resubmitted"). Before this an Ar could
-- re-upload or rename a cleared song and keep "cleared", which worked around 0018's
-- "a band cannot upload a pre-cleared song". A rejected song re-uploaded is a new
-- candidate the same way. Approvers' own edits keep the verdict.
--
-- guard_song_update: 0045's body with the block marked 0047 added before the return.
-- Run with: npm run migrate supabase/migrations/0047_song_back_to_review.sql

create or replace function public.guard_song_update()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  is_editor   boolean := public.can_edit_group(new.group_id);
  is_approver boolean := public.can_approve(new.tenant_id);
  other_changed boolean;
begin
  if not (is_editor or is_approver) then
    raise exception 'not allowed to update this song';
  end if;
  -- copyright_status: approver-only (an Ar can no longer self-clear)
  if new.copyright_status is distinct from old.copyright_status and not is_approver then
    raise exception 'only an approver may change copyright_status';
  end if;
  -- everything else: editor-only
  other_changed :=
       new.title            is distinct from old.title
    or new.file_name        is distinct from old.file_name
    or new.duration_seconds is distinct from old.duration_seconds
    or new.language         is distinct from old.language
    or new.category         is distinct from old.category
    or new.notes            is distinct from old.notes
    or new.bpm              is distinct from old.bpm              -- 0025 (added 0034)
    or new.group_id         is distinct from old.group_id
    or new.tenant_id        is distinct from old.tenant_id
    or new.audio_path       is distinct from old.audio_path
    or new.audio_name       is distinct from old.audio_name
    or new.audio_expires_at is distinct from old.audio_expires_at
    or new.cover            is distinct from old.cover            -- 0044
    or new.lufs             is distinct from old.lufs             -- 0045
    or new.peaks            is distinct from old.peaks            -- 0045
    or new.beat_offset      is distinct from old.beat_offset      -- 0045
    or new.id               is distinct from old.id               -- 0002 (missed by 0018)
    or new.created_at       is distinct from old.created_at;      -- 0002 (missed by 0018)
  if other_changed and not is_editor then
    raise exception 'only an editor may change song details';
  end if;
  -- 0047: a REVIEWED song (cleared or rejected) whose file or title a non-approver
  -- changes goes back to review. The clearance was given to that recording under that
  -- name; a new file (or a new name) is a new thing to check. An approver's own edit
  -- keeps the verdict. Removing the file (audio_path -> null) is not a new recording,
  -- and a title that differs only in case or spacing is the same title.
  if not is_approver
     and old.copyright_status in ('cleared', 'rejected')
     and new.copyright_status is not distinct from old.copyright_status
     and (
       (new.audio_path is not null and new.audio_path is distinct from old.audio_path)
       or lower(btrim(coalesce(new.title, ''))) is distinct from lower(btrim(coalesce(old.title, '')))
     ) then
    new.copyright_status := 'pending';
  end if;
  return new;
end; $$;
