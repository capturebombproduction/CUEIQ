-- 0020_protect_master_admin.sql
-- DB-level hardening for the "Master Admin" account (mirrors the app-level guard
-- in lib/master-admin.ts). The app route already blocks deleting/demoting it, but
-- that only covers the UI path. These triggers protect it at the database, so a
-- direct REST/SQL call OR a service-role operation (which BYPASSES RLS) still
-- cannot delete the account or strip its admin powers. To lift the protection you
-- must drop these triggers in a new migration — no admin/API can do it at runtime.
--
-- Identified by (synthetic) email — keep this list in sync with MASTER_ADMIN_EMAILS
-- in lib/master-admin.ts.

-- Single source of truth for the protected email list.
create or replace function public.protected_master_emails()
returns text[] language sql immutable as $$
  select array['architect@cueiq.local']::text[];
$$;

create or replace function public.is_protected_master(uid uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid
      and lower(coalesce(u.email, '')) = any (public.protected_master_emails())
  );
$$;

-- ---------------------------------------------------------------------
-- (1) auth.users — the account itself can never be deleted (blocks GoTrue
--     admin.deleteUser / service-role / direct SQL alike).
-- ---------------------------------------------------------------------
create or replace function public.block_master_delete()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if lower(coalesce(old.email, '')) = any (public.protected_master_emails()) then
    raise exception 'Master Admin account is protected and cannot be deleted';
  end if;
  return old;
end; $$;

drop trigger if exists users_block_master_delete on auth.users;
create trigger users_block_master_delete
  before delete on auth.users
  for each row execute function public.block_master_delete();

-- ---------------------------------------------------------------------
-- (2) tenant_members — the master's membership can't be removed, and its
--     tenant role can't be demoted away from admin (a back-door neutralise).
-- ---------------------------------------------------------------------
create or replace function public.protect_master_membership()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if public.is_protected_master(old.user_id) then
      raise exception 'Master Admin membership is protected and cannot be removed';
    end if;
    return old;
  end if;
  -- UPDATE: keep the master pinned as admin of its own tenant.
  if public.is_protected_master(old.user_id) then
    if new.role is distinct from 'admin'
       or new.user_id is distinct from old.user_id
       or new.tenant_id is distinct from old.tenant_id then
      raise exception 'Master Admin role is protected and cannot be changed';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists tenant_members_protect_master on public.tenant_members;
create trigger tenant_members_protect_master
  before update or delete on public.tenant_members
  for each row execute function public.protect_master_membership();

-- ---------------------------------------------------------------------
-- (3) profiles — defense in depth against a direct profile-row delete
--     (the auth.users guard already stops the cascade path).
-- ---------------------------------------------------------------------
create or replace function public.block_master_profile_delete()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if lower(coalesce(old.email, '')) = any (public.protected_master_emails()) then
    raise exception 'Master Admin profile is protected and cannot be deleted';
  end if;
  return old;
end; $$;

drop trigger if exists profiles_block_master_delete on public.profiles;
create trigger profiles_block_master_delete
  before delete on public.profiles
  for each row execute function public.block_master_profile_delete();
