-- 0027_feedback_and_errors.sql
-- Two self-contained tools for the "real label use → gather feedback" phase
-- (no external service / no Sentry — stays free + in our own Supabase):
--   (1) feedback        — in-app feedback / bug-report channel (anyone submits)
--   (2) client_errors   — auto-captured client errors (admins read; debugging)
-- This project has NO default privileges to `authenticated` (see 0001/0017/0026),
-- so each table needs explicit grants. 0026 added a default-privileges safety net,
-- but we GRANT explicitly here too to be safe + self-documenting.

-- ---------------------------------------------------------------------
-- (1) feedback — submitted by any tenant member; admins triage.
-- ---------------------------------------------------------------------
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references public.tenants(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  category   text not null default 'other',     -- bug | idea | other
  message    text not null,
  context    jsonb not null default '{}'::jsonb, -- { path, commit, ua }
  status     text not null default 'open',       -- open | done
  created_at timestamptz not null default now()
);
create index if not exists feedback_tenant_created_idx
  on public.feedback (tenant_id, created_at desc);

alter table public.feedback enable row level security;

-- submit: any member of the tenant, for their OWN user_id only.
drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback
  for insert with check (user_id = auth.uid() and public.is_tenant_member(tenant_id));
-- read: your own rows, or any admin of the tenant.
drop policy if exists feedback_select on public.feedback;
create policy feedback_select on public.feedback
  for select using (user_id = auth.uid() or public.can_admin_tenant(tenant_id));
-- triage (status) + delete: admins only.
drop policy if exists feedback_update on public.feedback;
create policy feedback_update on public.feedback
  for update using (public.can_admin_tenant(tenant_id))
  with check (public.can_admin_tenant(tenant_id));
drop policy if exists feedback_delete on public.feedback;
create policy feedback_delete on public.feedback
  for delete using (public.can_admin_tenant(tenant_id));

grant select, insert, update, delete on public.feedback to authenticated;
grant all on public.feedback to service_role;

-- ---------------------------------------------------------------------
-- (2) client_errors — best-effort auto-capture from the browser.
-- Only authenticated users log (their own user_id); admins read to debug.
-- ---------------------------------------------------------------------
create table if not exists public.client_errors (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  kind        text not null default 'error',  -- error | unhandledrejection | react
  message     text not null,
  stack       text,
  url         text,
  user_agent  text,
  app_version text,
  created_at  timestamptz not null default now()
);
create index if not exists client_errors_tenant_created_idx
  on public.client_errors (tenant_id, created_at desc);

alter table public.client_errors enable row level security;

drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors
  for insert with check (user_id = auth.uid());
drop policy if exists client_errors_select on public.client_errors;
create policy client_errors_select on public.client_errors
  for select using (public.can_admin_tenant(tenant_id));
drop policy if exists client_errors_delete on public.client_errors;
create policy client_errors_delete on public.client_errors
  for delete using (public.can_admin_tenant(tenant_id));

grant select, insert, delete on public.client_errors to authenticated;
grant all on public.client_errors to service_role;
