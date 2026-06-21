-- 0024_practice_journal.sql
-- Practice Mode Slice 3: the practice journal + auto-log + attendance, all scoped to
-- a practice room (event) and its band (group).
--
-- practice_logs  — dated journal entries. category = note / problem / summary /
--   homework. visibility = 'shared' (band members see) or 'staff' (Ar/ครู + admin
--   only — private/individual coaching). target_member_id optionally tags one member
--   (individual notes). homework rows use `done` (+ carry over until ticked).
-- practice_runs  — auto-log: a song that was practiced (seconds + speed) on a date.
-- practice_attendance — who attended on a date (Ar takes it).

-- ── practice_logs ─────────────────────────────────────────────────────────
create table if not exists public.practice_logs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  group_id         uuid not null references public.groups(id) on delete cascade,
  event_id         uuid not null references public.events(id) on delete cascade,
  log_date         date not null default (now() at time zone 'Asia/Bangkok')::date,
  author_id        uuid references auth.users(id) on delete set null,
  visibility       text not null default 'shared' check (visibility in ('shared','staff')),
  category         text not null default 'note'   check (category in ('note','problem','summary','homework')),
  body             text not null default '',
  target_member_id uuid references public.members(id) on delete set null,
  done             boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists practice_logs_event_idx on public.practice_logs(event_id);

alter table public.practice_logs enable row level security;

-- READ: any band viewer sees 'shared'; only an editor (Ar/admin) sees 'staff'.
drop policy if exists practice_logs_select on public.practice_logs;
create policy practice_logs_select on public.practice_logs
  for select using (
    public.can_view_group(group_id)
    and (visibility = 'shared' or public.can_edit_group(group_id))
  );

-- INSERT: you author your own row; members may post 'shared', staff requires an editor.
drop policy if exists practice_logs_insert on public.practice_logs;
create policy practice_logs_insert on public.practice_logs
  for insert with check (
    author_id = auth.uid()
    and public.can_view_group(group_id)
    and (visibility = 'shared' or public.can_edit_group(group_id))
  );

-- UPDATE/DELETE: the author, or any band editor (Ar/admin).
drop policy if exists practice_logs_update on public.practice_logs;
create policy practice_logs_update on public.practice_logs
  for update using (author_id = auth.uid() or public.can_edit_group(group_id))
  with check (author_id = auth.uid() or public.can_edit_group(group_id));
drop policy if exists practice_logs_delete on public.practice_logs;
create policy practice_logs_delete on public.practice_logs
  for delete using (author_id = auth.uid() or public.can_edit_group(group_id));

-- ── practice_runs (auto-log) ──────────────────────────────────────────────
create table if not exists public.practice_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  song_id     uuid references public.songs(id) on delete set null,
  song_title  text not null default '',
  seconds     int not null default 0,
  last_speed  double precision not null default 1,
  log_date    date not null default (now() at time zone 'Asia/Bangkok')::date,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists practice_runs_event_date_idx on public.practice_runs(event_id, log_date);

alter table public.practice_runs enable row level security;

drop policy if exists practice_runs_select on public.practice_runs;
create policy practice_runs_select on public.practice_runs
  for select using (public.can_view_group(group_id));
drop policy if exists practice_runs_insert on public.practice_runs;
create policy practice_runs_insert on public.practice_runs
  for insert with check (created_by = auth.uid() and public.can_view_group(group_id));

-- ── practice_attendance ───────────────────────────────────────────────────
create table if not exists public.practice_attendance (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  event_id    uuid not null references public.events(id) on delete cascade,
  log_date    date not null default (now() at time zone 'Asia/Bangkok')::date,
  member_id   uuid not null references public.members(id) on delete cascade,
  present     boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (event_id, log_date, member_id)
);
create index if not exists practice_attendance_event_date_idx on public.practice_attendance(event_id, log_date);

alter table public.practice_attendance enable row level security;

drop policy if exists practice_attendance_select on public.practice_attendance;
create policy practice_attendance_select on public.practice_attendance
  for select using (public.can_view_group(group_id));
drop policy if exists practice_attendance_write on public.practice_attendance;
create policy practice_attendance_write on public.practice_attendance
  for all using (public.can_edit_group(group_id))
  with check (public.can_edit_group(group_id));
