-- =====================================================================
-- CueIQ — Phase 2: Per-event member lineup (who performs at THIS show)
--
-- Idol groups rotate members, so each event tracks which members are on.
-- A row in event_members = that member is IN the lineup for that event.
-- (No rows yet = lineup not chosen — the UI offers a "select all".)
--
-- Run in Supabase → SQL Editor (owner). Safe to re-run.
-- =====================================================================

create table if not exists public.event_members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  member_id   uuid not null references public.members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (event_id, member_id)
);

create index if not exists idx_event_members_event on public.event_members(event_id);

alter table public.event_members enable row level security;

drop policy if exists event_members_select on public.event_members;
create policy event_members_select on public.event_members
  for select using (public.is_tenant_member(tenant_id));

drop policy if exists event_members_write on public.event_members;
create policy event_members_write on public.event_members
  for all using (public.can_edit_tenant(tenant_id))
  with check (public.can_edit_tenant(tenant_id));

grant select, insert, update, delete on public.event_members to authenticated;
