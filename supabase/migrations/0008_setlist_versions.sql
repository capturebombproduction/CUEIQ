-- =====================================================================
-- CueIQ — Phase 2: Setlist version history (snapshot + restore)
--
-- Save a named snapshot of an event's setlist, then restore it later if an edit
-- goes wrong. snapshot = a jsonb array of the setlist rows at save time.
--
-- Run in Supabase → SQL Editor (owner). Safe to re-run.
-- =====================================================================

create table if not exists public.setlist_versions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  label       text,
  snapshot    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);

create index if not exists idx_setlist_versions_event
  on public.setlist_versions(event_id, created_at desc);

alter table public.setlist_versions enable row level security;

drop policy if exists setlist_versions_select on public.setlist_versions;
create policy setlist_versions_select on public.setlist_versions
  for select using (public.is_tenant_member(tenant_id));

drop policy if exists setlist_versions_write on public.setlist_versions;
create policy setlist_versions_write on public.setlist_versions
  for all using (public.can_edit_tenant(tenant_id))
  with check (public.can_edit_tenant(tenant_id));

grant select, insert, update, delete on public.setlist_versions to authenticated;
