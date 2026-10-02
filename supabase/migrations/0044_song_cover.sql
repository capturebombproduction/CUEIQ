-- 0044_song_cover.sql
-- Song cover art (พี่, 2026-10-03: "อยากใส่ปกเพลง … ฟิลอัพโหลดเพลงได้ งี้ เป็น icon เสริมอีกทาง").
--
-- songs.cover = a SMALL square thumbnail as a data URL (the client crops it square and
-- encodes it at 192 px - see lib/song-cover.ts - so a cover is ~10 KB of text). Kept on
-- the row on purpose, not in R2: the library lists every song at once, and an R2 image
-- would cost one presign round trip per song every 15 minutes, and nothing at all
-- offline. On the row it arrives with the list it decorates, in the same request, and
-- the desktop app's offline song cache carries it for free.
--
-- The check keeps the column to what the client writes: an image data URL, base64,
-- capped well above a 192 px WebP/JPEG (a ~20 KB image is ~27 K chars) and far below
-- anything that would make the songs list heavy.
--
-- guard_song_update: `cover` joins the editor-only columns (admin / the band's Ar), like
-- the title and the audio. label_staff and members cannot change it. The body is 0038's
-- with that one line added.
-- Additive + idempotent. Run with: npm run migrate supabase/migrations/0044_song_cover.sql

alter table public.songs add column if not exists cover text;

alter table public.songs drop constraint if exists songs_cover_shape;
alter table public.songs add constraint songs_cover_shape check (
  cover is null
  or (
    length(cover) <= 60000
    and cover ~ '^data:image/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$'
  )
);

comment on column public.songs.cover is
  'Square cover thumbnail as a data URL (image/webp|jpeg|png, base64, <= 60000 chars); null = none';

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
    or new.id               is distinct from old.id               -- 0002 (missed by 0018)
    or new.created_at       is distinct from old.created_at;      -- 0002 (missed by 0018)
  if other_changed and not is_editor then
    raise exception 'only an editor may change song details';
  end if;
  return new;
end; $$;
