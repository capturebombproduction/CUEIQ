-- 0045 song analysis: what the audio file itself says, measured once and kept on the song so
-- every device can use it - phones included, which never hold the audio in Live Mode:
--   lufs         integrated loudness, ITU-R BS.1770-4 / EBU R128 (lib/song-analysis.ts). Live
--                compares the next song with the one playing ("+3.1 dB ดังกว่า").
--   peaks        a 200-point waveform, one base64url character per point: the block's RMS
--                level, -42..0 dBFS as 0-63. Live draws it as the NOW card's progress bar.
--   beat_offset  the first tracked beat, in seconds (lib/bpm-detect.ts detectBeats). With
--                songs.bpm it puts Live's beat light on the music's own beat.
-- Written by the library right after an upload, and for songs uploaded before this by
-- review-shots/song-analysis-backfill.mjs. All three are editor-only, like the audio.
-- Additive + idempotent. Run with: npm run migrate supabase/migrations/0045_song_analysis.sql

alter table public.songs add column if not exists lufs real;
alter table public.songs add column if not exists peaks text;
alter table public.songs add column if not exists beat_offset real;

alter table public.songs drop constraint if exists songs_lufs_range;
alter table public.songs add constraint songs_lufs_range check (lufs is null or (lufs >= -70 and lufs <= 10));

alter table public.songs drop constraint if exists songs_peaks_shape;
alter table public.songs add constraint songs_peaks_shape check (
  peaks is null or (length(peaks) between 16 and 2048 and peaks ~ '^[A-Za-z0-9_-]+$')
);

alter table public.songs drop constraint if exists songs_beat_offset_range;
alter table public.songs add constraint songs_beat_offset_range check (
  beat_offset is null or (beat_offset >= 0 and beat_offset < 3600)
);

comment on column public.songs.lufs is
  'Integrated loudness of the audio file, LUFS (ITU-R BS.1770-4); null = not measured';
comment on column public.songs.peaks is
  'Waveform overview: one base64url char per point, RMS level -42..0 dBFS as 0-63; null = not measured';
comment on column public.songs.beat_offset is
  'Time of the first tracked beat, seconds; null = not measured';

-- guard_song_update: the three analysis columns join the editor-only list. The body is
-- 0044's with those three lines added.
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
  return new;
end; $$;
