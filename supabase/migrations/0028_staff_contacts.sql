-- 0028_staff_contacts.sql
-- Reusable contact directory for the Overview "บันทึกเป็นรูป" staff schedule:
--   (1) staff_contacts          — label-wide crew (ช่างภาพ / ประสานงาน / …)
--   (2) groups.contact_name/phone — per-band representative
-- The export's contact block = crew + the reps of whichever bands appear that day,
-- so staff set it once instead of re-typing an Excel sheet every show.
-- This project grants no default privileges to `authenticated`, so grant explicitly.

-- (1) label-wide crew directory ------------------------------------------
create table if not exists public.staff_contacts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null default '',
  role       text not null default '',   -- ช่างภาพ / ประสานงาน / sound / …
  phone      text not null default '',
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists staff_contacts_tenant_idx
  on public.staff_contacts (tenant_id, sort_order);

alter table public.staff_contacts enable row level security;

-- read: any member of the tenant (the overview export reads it).
drop policy if exists staff_contacts_select on public.staff_contacts;
create policy staff_contacts_select on public.staff_contacts
  for select using (public.is_tenant_member(tenant_id));
-- manage (insert / update / delete): tenant admins only.
drop policy if exists staff_contacts_insert on public.staff_contacts;
create policy staff_contacts_insert on public.staff_contacts
  for insert with check (public.can_admin_tenant(tenant_id));
drop policy if exists staff_contacts_update on public.staff_contacts;
create policy staff_contacts_update on public.staff_contacts
  for update using (public.can_admin_tenant(tenant_id))
  with check (public.can_admin_tenant(tenant_id));
drop policy if exists staff_contacts_delete on public.staff_contacts;
create policy staff_contacts_delete on public.staff_contacts
  for delete using (public.can_admin_tenant(tenant_id));

grant select, insert, update, delete on public.staff_contacts to authenticated;
grant all on public.staff_contacts to service_role;

-- (2) per-band representative --------------------------------------------
-- (groups already has RLS + grants from 0001 — UPDATE covers the new columns.)
alter table public.groups add column if not exists contact_name  text;
alter table public.groups add column if not exists contact_phone text;
