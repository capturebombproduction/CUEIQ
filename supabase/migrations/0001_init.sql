-- =====================================================================
-- CueIQ — initial schema (multi-tenant SaaS + Row-Level Security)
-- Run this in Supabase → SQL Editor (or `supabase db push`).
-- Safe to re-run.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'artist_manager',
  created_at  timestamptz not null default now()
);

create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,
  logo_url    text,
  created_at  timestamptz not null default now()
);

create table if not exists public.tenant_members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'artist_manager',
  created_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  color       text,
  exempt_from_deadline boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.members (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  name        text not null,
  nickname    text,
  mic_number  int,
  color       text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  group_id        uuid not null references public.groups(id) on delete cascade,
  name            text not null,
  event_date      date,
  venue           text,
  event_type      text not null default 'idol',
  show_start_time time,
  hard_out_time   time,
  status          text not null default 'draft',
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.schedule_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  kind        text not null default 'other',
  label       text,
  location    text,
  start_time  time,
  end_time    time,
  notes       text,
  sort_order  int not null default 0
);

create table if not exists public.setlist_items (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  event_id               uuid not null references public.events(id) on delete cascade,
  kind                   text not null default 'song',
  title                  text not null default '',
  duration_seconds       int not null default 0,
  buffer_before_seconds  int not null default 0,
  buffer_after_seconds   int not null default 0,
  mic_slots              jsonb not null default '[]'::jsonb,
  notes                  text,
  sort_order             int not null default 0
);

create table if not exists public.mic_assignments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  mic_number  int not null,
  holder_name text not null,
  order_index int not null default 0,
  created_at  timestamptz not null default now()
);

-- keep events.updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();

-- indexes
create index if not exists idx_tenant_members_user on public.tenant_members(user_id);
create index if not exists idx_groups_tenant       on public.groups(tenant_id);
create index if not exists idx_members_group        on public.members(group_id);
create index if not exists idx_events_tenant        on public.events(tenant_id);
create index if not exists idx_events_group         on public.events(group_id);
create index if not exists idx_schedule_event       on public.schedule_items(event_id);
create index if not exists idx_setlist_event        on public.setlist_items(event_id);
create index if not exists idx_mic_event            on public.mic_assignments(event_id);

-- ---------------------------------------------------------------------
-- Helper functions for RLS (SECURITY DEFINER avoids policy recursion)
-- ---------------------------------------------------------------------
create or replace function public.is_tenant_member(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = tid and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_tenant(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = tid and m.user_id = auth.uid()
      and m.role in ('platform_admin','tenant_owner','label_staff','artist_manager')
  );
$$;

grant execute on function public.is_tenant_member(uuid) to authenticated;
grant execute on function public.can_edit_tenant(uuid)  to authenticated;

-- Table-level grants (required in newer Supabase projects — not auto-granted)
grant usage on schema public to authenticated;

grant select          on public.profiles        to authenticated;
grant update          on public.profiles        to authenticated;
grant select          on public.tenants         to authenticated;
grant select          on public.tenant_members  to authenticated;
grant select, insert, update, delete on public.groups          to authenticated;
grant select, insert, update, delete on public.members         to authenticated;
grant select, insert, update, delete on public.events          to authenticated;
grant select, insert, update, delete on public.schedule_items  to authenticated;
grant select, insert, update, delete on public.setlist_items   to authenticated;
grant select, insert, update, delete on public.mic_assignments to authenticated;

-- ---------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.tenants         enable row level security;
alter table public.tenant_members  enable row level security;
alter table public.groups          enable row level security;
alter table public.members         enable row level security;
alter table public.events          enable row level security;
alter table public.schedule_items  enable row level security;
alter table public.setlist_items   enable row level security;
alter table public.mic_assignments enable row level security;

-- profiles: each user manages their own row
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert with check (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- tenants: members can read; editors can update
-- Inline subquery avoids calling is_tenant_member() which would re-enter
-- tenant_members RLS and cause infinite recursion.
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select using (
    exists (
      select 1 from public.tenant_members m
      where m.tenant_id = id and m.user_id = auth.uid()
    )
  );
drop policy if exists tenants_update on public.tenants;
create policy tenants_update on public.tenants
  for update using (public.can_edit_tenant(id)) with check (public.can_edit_tenant(id));

-- tenant_members: each user can always see their own rows.
-- Direct check avoids calling is_tenant_member() which would query this same
-- table and trigger infinite recursion under some Supabase RLS configurations.
drop policy if exists tenant_members_select on public.tenant_members;
create policy tenant_members_select on public.tenant_members
  for select using (user_id = auth.uid());

-- domain tables: members read, editors write.
-- (two permissive policies OR together: select for any member, writes only for editors)
do $$
declare t text;
begin
  foreach t in array array['groups','members','events','schedule_items','setlist_items','mic_assignments']
  loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format(
      'create policy %1$s_select on public.%1$s for select using (public.is_tenant_member(tenant_id))', t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all using (public.can_edit_tenant(tenant_id)) with check (public.can_edit_tenant(tenant_id))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- New-user handling: create profile + auto-join the demo workspace
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  v_role text;
  v_name text;
  v_demo uuid := '00000000-0000-0000-0000-000000000001';
begin
  v_role := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'artist_manager');
  v_name := coalesce(nullif(new.raw_user_meta_data->>'full_name', ''),
                     split_part(coalesce(new.email,''), '@', 1));

  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, v_name, v_role)
  on conflict (id) do update set email = excluded.email;

  -- Auto-join the CueIQ demo workspace so testers see the VANTAFLARE seed.
  if exists (select 1 from public.tenants where id = v_demo) then
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_demo, new.id, v_role)
    on conflict (tenant_id, user_id) do nothing;
  end if;

  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RPC so a user created BEFORE the seed can still join the demo workspace.
create or replace function public.join_demo()
returns void language plpgsql security definer
set search_path = public as $$
declare
  v_demo uuid := '00000000-0000-0000-0000-000000000001';
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not exists (select 1 from public.tenants where id = v_demo) then
    raise exception 'demo workspace not found — run supabase/seed.sql first';
  end if;
  select coalesce(role, 'artist_manager') into v_role
    from public.profiles where id = auth.uid();
  insert into public.tenant_members (tenant_id, user_id, role)
  values (v_demo, auth.uid(), coalesce(v_role, 'artist_manager'))
  on conflict (tenant_id, user_id) do nothing;
end; $$;

grant execute on function public.join_demo() to authenticated;
