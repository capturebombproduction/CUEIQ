-- 0053_song_audio_follows_band.sql
-- A song's file lives under its band's folder - <tenant>/<band>/songs/<song>-<token>.<ext>
-- (lib/audio-remote.ts buildSongAudioPath) - and presign lets only that band's viewers
-- read it (lib/presign-authz.ts). A song whose band and file folder disagree is silent
-- for the band it belongs to (403) while an admin still hears it.
--
-- The Library refuses a band move while the song has a file (2026-10-26) or one queued or
-- uploading on THIS device (2026-10-27). What only the server can see:
--   • a STALE list - another device attached a file after this one loaded the Library,
--     then this one moves the band (known since the 2026-10-27 hunt);
--   • a file that LANDS after the move - an upload or a queued desktop flush whose key was
--     minted under the old band.
-- Both are refused here, for every writer. Removing the file (audio_path -> null) in the
-- same update as the move is fine, and so is a row whose file already sits under its band.
--
-- Measured on prod 2026-10-27: 40 songs with a file, 0 whose folder is another band's, 0
-- under another tenant, 0 outside songs/ - nothing to repair, and no unrelated edit of an
-- existing row can trip this (it only looks when group_id or audio_path changes).
--
-- The rest of the function is 0047's body unchanged (read back from prod 2026-10-27).
--
-- Additive + idempotent (create or replace). Safe to re-run. Apply with:
--   node --env-file=.env.local scripts/migrate.mjs supabase/migrations/0053_song_audio_follows_band.sql

create or replace function public.guard_song_update()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  -- 0053: the file stays under the song's own band (see the header). Only when the band
  -- or the file changes, so an edit of an unrelated column never trips over old data.
  if new.audio_path is not null
     and (new.group_id is distinct from old.group_id or new.audio_path is distinct from old.audio_path)
     and split_part(new.audio_path, '/', 2) is distinct from new.group_id::text then
    raise exception 'song audio belongs to another band'
      using hint = 'ไฟล์เสียงของเพลงนี้อยู่ใต้วงอื่น — ลบไฟล์เสียงก่อน ย้ายวง แล้วอัปไฟล์ใหม่';
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
end; $function$;
