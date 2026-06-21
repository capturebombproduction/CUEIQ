-- 0023_song_markers.sql
-- Practice Mode Slice 2: section markers on a library song (Intro / Verse / Hook /
-- custom). Markers are per-SONG so they're defined once and reused in every practice
-- session. View = anyone who can see the band; write = the band's Ar (or admin) —
-- same boundary as the song library. Members jump to markers + use the ad-hoc A-B
-- loop (client-side, saves nothing).
create table if not exists public.song_markers (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  group_id         uuid not null references public.groups(id) on delete cascade,
  song_id          uuid not null references public.songs(id) on delete cascade,
  label            text not null,
  position_seconds double precision not null default 0,
  sort_order       int not null default 0,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists song_markers_song_idx on public.song_markers(song_id);

alter table public.song_markers enable row level security;

drop policy if exists song_markers_select on public.song_markers;
create policy song_markers_select on public.song_markers
  for select using (public.can_view_group(group_id));

drop policy if exists song_markers_write on public.song_markers;
create policy song_markers_write on public.song_markers
  for all using (public.can_edit_group(group_id))
  with check (public.can_edit_group(group_id));
