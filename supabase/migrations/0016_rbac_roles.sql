-- =====================================================================
-- CueIQ — Phase 1 RBAC: per-band role model + RLS rewrite
--
-- Introduces a TWO-TIER role model:
--   • Tenant tier (tenant_members.role) — label-wide power, allow-listed:
--       admin       → sees + edits everything, approves, real-time Live edit
--       ceo         → sees everything, edits NOTHING (observer)
--       label_staff → sees everything (overview), edits nothing EXCEPT
--                     approve/reject songs + photo-time (self_photo=off bands)
--   • Group tier (group_roles.role) — band-scoped:
--       artist_manager (Ar) → view + edit own band's event(s) + roster
--       member              → view own band only (no edit)
--   A band-scoped user keeps an INERT tenant_members.role ('member'/'artist_manager'
--   that is NOT in the label-wide allow-list) — real power comes from group_roles.
--
-- Also LOCKS DOWN onboarding (open-registration debt): handle_new_user no longer
-- auto-joins anyone or trusts the client-supplied role; join_demo is disabled.
--
-- Additive + idempotent. Safe to re-run. Run with:
--   npm run migrate supabase/migrations/0016_rbac_roles.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- (1) New table: per-band roles
-- ---------------------------------------------------------------------
create table if not exists public.group_roles (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  group_id   uuid not null references public.groups(id)  on delete cascade,
  user_id    uuid not null references auth.users(id)     on delete cascade,
  role       text not null check (role in ('artist_manager','member')),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)              -- one role per user per band
);

create index if not exists idx_group_roles_user  on public.group_roles(user_id);
create index if not exists idx_group_roles_group on public.group_roles(group_id);

grant select, insert, update, delete on public.group_roles to authenticated;

-- ---------------------------------------------------------------------
-- (2) Per-band photo-time ownership flag
--   true  = band schedules its own photo time (e.g. Seishin — own photographer)
--   false = a shared label photographer; label_staff fills the photo time in
-- ---------------------------------------------------------------------
alter table public.groups add column if not exists self_photo boolean not null default false;

-- ---------------------------------------------------------------------
-- (3) Permission helper functions (SECURITY DEFINER → bypass RLS, no recursion)
-- ---------------------------------------------------------------------

-- The caller's tenant-tier role (null = not a member of that tenant).
create or replace function public.app_tenant_role(tid uuid)
returns text language sql security definer stable
set search_path = public as $$
  select m.role from public.tenant_members m
  where m.tenant_id = tid and m.user_id = auth.uid()
  limit 1;
$$;

-- Full power over the whole tenant (every band).
create or replace function public.can_admin_tenant(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select coalesce(
    public.app_tenant_role(tid) in ('admin','platform_admin','tenant_owner'),
    false);
$$;

-- Label-wide VISIBILITY (can see every band in the tenant).
create or replace function public.is_label_wide(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select coalesce(
    public.app_tenant_role(tid) in
      ('admin','platform_admin','tenant_owner','ceo','label_staff'),
    false);
$$;

-- Can approve/reject (songs + events).
create or replace function public.can_approve(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select coalesce(
    public.app_tenant_role(tid) in
      ('admin','platform_admin','tenant_owner','label_staff'),
    false);
$$;

-- Can SEE a band's data: label-wide roles see all; otherwise needs a group_roles row.
create or replace function public.can_view_group(gid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and (
      public.is_label_wide(g.tenant_id)
      or exists (
        select 1 from public.group_roles gr
        where gr.group_id = gid and gr.user_id = auth.uid()
      )
    )
  );
$$;

-- Can EDIT a band's events/roster: tenant admin, OR the band's Ar.
create or replace function public.can_edit_group(gid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and (
      public.can_admin_tenant(g.tenant_id)
      or exists (
        select 1 from public.group_roles gr
        where gr.group_id = gid and gr.user_id = auth.uid()
          and gr.role = 'artist_manager'
      )
    )
  );
$$;

-- Event-scoped wrappers (resolve event -> group). Used by tables that only carry
-- event_id (schedule_items, setlist_items, mic_assignments, event_members,
-- setlist_versions).
create or replace function public.can_view_event(eid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = eid and public.can_view_group(e.group_id)
  );
$$;

create or replace function public.can_edit_event(eid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = eid and public.can_edit_group(e.group_id)
  );
$$;

-- Photo-time exception: a normal editor of the event, OR an approver (label_staff)
-- for a band that does NOT schedule its own photo time.
create or replace function public.can_edit_photo_time(eid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.events e
    join public.groups g on g.id = e.group_id
    where e.id = eid and (
      public.can_edit_event(eid)
      or (public.can_approve(e.tenant_id) and g.self_photo = false)
    )
  );
$$;

-- Re-scope the legacy tenant-edit helper to ADMIN ONLY (it now only guards
-- tenants_update + the presign legacy-key fallback). is_tenant_member stays as-is
-- (any membership) for legacy-key reads.
create or replace function public.can_edit_tenant(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select coalesce(
    public.app_tenant_role(tid) in ('admin','platform_admin','tenant_owner'),
    false);
$$;

grant execute on function public.app_tenant_role(uuid)     to authenticated;
grant execute on function public.can_admin_tenant(uuid)    to authenticated;
grant execute on function public.is_label_wide(uuid)       to authenticated;
grant execute on function public.can_approve(uuid)         to authenticated;
grant execute on function public.can_view_group(uuid)      to authenticated;
grant execute on function public.can_edit_group(uuid)      to authenticated;
grant execute on function public.can_view_event(uuid)      to authenticated;
grant execute on function public.can_edit_event(uuid)      to authenticated;
grant execute on function public.can_edit_photo_time(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- (4) RLS — group_roles
-- ---------------------------------------------------------------------
alter table public.group_roles enable row level security;

drop policy if exists group_roles_select on public.group_roles;
create policy group_roles_select on public.group_roles
  for select using (
    user_id = auth.uid() or public.can_admin_tenant(tenant_id)
  );

drop policy if exists group_roles_write on public.group_roles;
create policy group_roles_write on public.group_roles
  for all using (public.can_admin_tenant(tenant_id))
  with check (public.can_admin_tenant(tenant_id));

-- ---------------------------------------------------------------------
-- (5) RLS rewrite — group-scoped tables
-- ---------------------------------------------------------------------

-- groups: view = can_view_group; create/edit/delete band + settings = admin only.
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select using (public.can_view_group(id));
drop policy if exists groups_write on public.groups;
create policy groups_write on public.groups
  for all using (public.can_admin_tenant(tenant_id))
  with check (public.can_admin_tenant(tenant_id));

-- members (roster): view = can_view_group; write = admin OR the band's Ar.
drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select using (public.can_view_group(group_id));
drop policy if exists members_write on public.members;
create policy members_write on public.members
  for all using (public.can_edit_group(group_id))
  with check (public.can_edit_group(group_id));

-- events: view = can_view_group; write = admin OR the band's Ar.
drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select using (public.can_view_group(group_id));
drop policy if exists events_write on public.events;
create policy events_write on public.events
  for all using (public.can_edit_group(group_id))
  with check (public.can_edit_group(group_id));

-- songs: view = can_view_group; insert/delete = editor; update = editor OR approver
--        (a column guard trigger limits approvers to copyright_status only).
drop policy if exists songs_select on public.songs;
create policy songs_select on public.songs
  for select using (public.can_view_group(group_id));

drop policy if exists songs_write on public.songs;   -- old for-all policy
drop policy if exists songs_insert on public.songs;
create policy songs_insert on public.songs
  for insert with check (public.can_edit_group(group_id));
drop policy if exists songs_delete on public.songs;
create policy songs_delete on public.songs
  for delete using (public.can_edit_group(group_id));
drop policy if exists songs_update on public.songs;
create policy songs_update on public.songs
  for update
  using (public.can_edit_group(group_id) or public.can_approve(tenant_id))
  with check (public.can_edit_group(group_id) or public.can_approve(tenant_id));

-- Column guard: an approver who is NOT a band editor may change ONLY copyright_status.
create or replace function public.guard_song_update()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if public.can_edit_group(new.group_id) then
    return new;                              -- full editor: anything goes
  end if;
  if public.can_approve(new.tenant_id) then  -- approver-only: copyright_status only
    if new.title            is distinct from old.title
       or new.file_name        is distinct from old.file_name
       or new.duration_seconds is distinct from old.duration_seconds
       or new.language         is distinct from old.language
       or new.category         is distinct from old.category
       or new.notes            is distinct from old.notes
       or new.group_id         is distinct from old.group_id
       or new.tenant_id        is distinct from old.tenant_id
       or new.audio_path       is distinct from old.audio_path
       or new.audio_name       is distinct from old.audio_name
       or new.audio_expires_at is distinct from old.audio_expires_at
    then
      raise exception 'label_staff may only change copyright_status';
    end if;
    return new;
  end if;
  raise exception 'not allowed to update this song';
end; $$;

drop trigger if exists songs_guard_update on public.songs;
create trigger songs_guard_update
  before update on public.songs
  for each row execute function public.guard_song_update();

-- ---------------------------------------------------------------------
-- (6) RLS rewrite — event-scoped tables (resolve to the event's band)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'schedule_items','setlist_items','mic_assignments','event_members','setlist_versions'
  ]
  loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format(
      'create policy %1$s_select on public.%1$s for select using (public.can_view_event(event_id))', t);
    execute format('drop policy if exists %1$s_write on public.%1$s', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all using (public.can_edit_event(event_id)) with check (public.can_edit_event(event_id))', t);
  end loop;
end $$;

-- schedule_items: label_staff photo-time exception (insert/update the photo row).
drop policy if exists schedule_items_photo_insert on public.schedule_items;
create policy schedule_items_photo_insert on public.schedule_items
  for insert with check (kind = 'photo' and public.can_edit_photo_time(event_id));
drop policy if exists schedule_items_photo_update on public.schedule_items;
create policy schedule_items_photo_update on public.schedule_items
  for update using (kind = 'photo' and public.can_edit_photo_time(event_id))
  with check (kind = 'photo' and public.can_edit_photo_time(event_id));

-- ---------------------------------------------------------------------
-- (7) Lock down onboarding (open-registration debt)
--   handle_new_user: create the profile ONLY. No auto-join, no client role.
--   Accounts are provisioned + assigned a tenant/band role by an admin.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  v_name text;
begin
  v_name := coalesce(nullif(new.raw_user_meta_data->>'full_name',''),
                     split_part(coalesce(new.email,''),'@',1));
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, v_name, 'member')
  on conflict (id) do update set email = excluded.email;
  return new;
end; $$;

-- join_demo: disabled. Self-service tenant join is closed; admins assign access.
create or replace function public.join_demo()
returns void language plpgsql security definer
set search_path = public as $$
begin
  raise exception 'การสมัครเข้าใช้งานถูกปิด — ติดต่อแอดมินเพื่อขอสิทธิ์เข้าวง';
end; $$;

-- ---------------------------------------------------------------------
-- (8) Migrate existing users to the new model (FAIL CLOSED)
--   Legacy 'artist_manager' tenant rows become INERT 'member' (powerless);
--   only the founder's known accounts are explicitly promoted to admin.
-- ---------------------------------------------------------------------
update public.tenant_members set role = 'admin'
  where role in ('platform_admin','tenant_owner');

update public.tenant_members set role = 'member'
  where role in ('artist_manager','sound_engineer','lighting','general_staff');

update public.tenant_members m
set role = 'admin'
from auth.users u
where m.user_id = u.id
  and u.email in ('cueiqtest@gmail.com','capturebombproduction@gmail.com')
  and m.tenant_id = '00000000-0000-0000-0000-000000000001';

-- Seishin Kakumei has its own photographer → schedules its own photo time
-- (decision #3). Other bands default self_photo=false (label fills photo time).
update public.groups set self_photo = true
  where id = 'c8788874-d6f9-41bd-a675-5d7628a15881';
