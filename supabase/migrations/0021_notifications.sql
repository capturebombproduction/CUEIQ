-- 0021_notifications.sql
-- In-app notifications + Web Push subscriptions.
--   * notifications      — one row PER RECIPIENT (the bell reads its own rows).
--                          Inserted by the service-role /api/notify route (which
--                          decides recipients), so no INSERT policy for end users.
--   * push_subscriptions — each device's Web Push endpoint; users manage their own.
-- Idempotent (safe to re-run).

-- ---------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id)  on delete cascade,
  user_id    uuid not null references auth.users(id)      on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  link       text,
  meta       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

-- Recipients can only see/modify their OWN notifications.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select using (user_id = auth.uid());
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete using (user_id = auth.uid());
-- (no INSERT policy: rows are created by the service-role route, which bypasses RLS)

grant select, update, delete on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- ---------------------------------------------------------------------
-- push_subscriptions (Web Push)
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id)     on delete cascade,
  tenant_id  uuid references public.tenants(id)          on delete set null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Each user manages only their own device subscriptions.
drop policy if exists push_subs_select on public.push_subscriptions;
create policy push_subs_select on public.push_subscriptions
  for select using (user_id = auth.uid());
drop policy if exists push_subs_insert on public.push_subscriptions;
create policy push_subs_insert on public.push_subscriptions
  for insert with check (user_id = auth.uid());
drop policy if exists push_subs_update on public.push_subscriptions;
create policy push_subs_update on public.push_subscriptions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists push_subs_delete on public.push_subscriptions;
create policy push_subs_delete on public.push_subscriptions
  for delete using (user_id = auth.uid());

grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;
