-- =====================================================================
-- CueIQ — Phase 2: Song Library (per-group song catalogue)
-- Stores only metadata (name, file name, detected duration) — NEVER the
-- audio file itself. Duration is detected client-side from the chosen file.
-- Run in Supabase → SQL Editor. Safe to re-run.
-- =====================================================================

create table if not exists public.songs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  group_id         uuid not null references public.groups(id) on delete cascade,
  title            text not null default '',
  file_name        text,
  duration_seconds int  not null default 0,
  language         text,            -- 'th' | 'jp' | 'kr' | 'en' | 'other' (free text)
  category         text,            -- free text, e.g. Title / B-side / Cover / Solo
  copyright_status text not null default 'pending',  -- cleared | pending | rejected
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_songs_group  on public.songs(group_id);
create index if not exists idx_songs_tenant on public.songs(tenant_id);

-- keep updated_at fresh (re-uses the function from 0001_init.sql)
drop trigger if exists songs_touch_updated_at on public.songs;
create trigger songs_touch_updated_at
  before update on public.songs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- RLS — same pattern as the other domain tables: members read, editors write.
-- (is_tenant_member / can_edit_tenant are SECURITY DEFINER helpers from 0001.)
-- ---------------------------------------------------------------------
alter table public.songs enable row level security;

drop policy if exists songs_select on public.songs;
create policy songs_select on public.songs
  for select using (public.is_tenant_member(tenant_id));

drop policy if exists songs_write on public.songs;
create policy songs_write on public.songs
  for all using (public.can_edit_tenant(tenant_id))
  with check (public.can_edit_tenant(tenant_id));

-- Table-level grant (REQUIRED — newer Supabase projects don't auto-grant).
grant select, insert, update, delete on public.songs to authenticated;
