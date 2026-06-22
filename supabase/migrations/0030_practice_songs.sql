-- 0030_practice_songs.sql
-- Practice Mode: the curated PRACTICE LIST for a room — a subset of the band's
-- library, chosen for this practice room (event with is_practice=true).
--
-- Deliberately NOT setlist_items: a real show's setlist is editor-only (Ar/admin),
-- but a practice list is a BAND activity — any member curates it themselves, since
-- members practice on their own / at home. So writes are gated to can_view_group
-- (any band member), mirroring practice_runs / shared practice_logs.

create table if not exists public.practice_songs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  song_id     uuid not null references public.songs(id) on delete cascade,
  sort_order  int  not null default 0,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (event_id, song_id) -- a song appears at most once per room
);
create index if not exists practice_songs_event_idx on public.practice_songs(event_id);

alter table public.practice_songs enable row level security;

-- READ + WRITE: any band viewer. Practice is collaborative within the band — every
-- member may add / reorder / remove songs (unlike the editor-only show setlist).
drop policy if exists practice_songs_select on public.practice_songs;
create policy practice_songs_select on public.practice_songs
  for select using (public.can_view_group(group_id));

drop policy if exists practice_songs_insert on public.practice_songs;
create policy practice_songs_insert on public.practice_songs
  for insert with check (public.can_view_group(group_id));

drop policy if exists practice_songs_update on public.practice_songs;
create policy practice_songs_update on public.practice_songs
  for update using (public.can_view_group(group_id))
  with check (public.can_view_group(group_id));

drop policy if exists practice_songs_delete on public.practice_songs;
create policy practice_songs_delete on public.practice_songs
  for delete using (public.can_view_group(group_id));

-- RLS ≠ GRANT on this project — the authenticated role needs explicit table grants.
grant select, insert, update, delete on public.practice_songs to authenticated;
