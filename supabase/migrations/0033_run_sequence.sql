-- 0033_run_sequence.sql
-- Festival-level running order ("Event Live Mode"): the timeline of a WHOLE show —
-- bands, games, ceremonies, MC, breaks — that staff run live. It spans the per-band
-- events (which the Overview groups into a "festival" by name + date), so it keys on
-- the festival (tenant + event_name + event_date), not a single event id.
-- Each row is one sequence. The live columns (actual_*, status, offset_min) stay null
-- until staff run the show (Phase 2 — the live show-caller). Approvers (admin +
-- label_staff) build & run it; any tenant member can watch. Additive table only —
-- touches nothing existing, safe to apply while bands use prod.

create table if not exists public.run_sequence (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  -- festival key (matches the Overview's name + date festival grouping)
  event_name      text not null,
  event_date      date,
  sort_order      int  not null default 0,
  title           text not null default '',
  kind            text not null default 'other',  -- band | game | ceremony | mc | break | other
  planned_start   time,
  planned_end     time,
  buffer_seconds  int  not null default 0,
  -- optional link to a band's stage event (to pull its time / open its setlist)
  linked_event_id uuid references public.events(id) on delete set null,
  -- live tracking (Phase 2 — the show-caller)
  actual_start    timestamptz,
  actual_end      timestamptz,
  status          text not null default 'pending', -- pending | live | done
  offset_min      int,                             -- run vs plan: late + / early −
  created_at      timestamptz not null default now()
);
create index if not exists run_sequence_festival_idx
  on public.run_sequence (tenant_id, event_name, event_date, sort_order);

alter table public.run_sequence enable row level security;

-- read: any tenant member (bands watch the run order).
drop policy if exists run_sequence_select on public.run_sequence;
create policy run_sequence_select on public.run_sequence
  for select using (public.is_tenant_member(tenant_id));
-- manage (insert / update / delete): approvers — admin + label_staff (can_approve).
drop policy if exists run_sequence_insert on public.run_sequence;
create policy run_sequence_insert on public.run_sequence
  for insert with check (public.can_approve(tenant_id));
drop policy if exists run_sequence_update on public.run_sequence;
create policy run_sequence_update on public.run_sequence
  for update using (public.can_approve(tenant_id))
  with check (public.can_approve(tenant_id));
drop policy if exists run_sequence_delete on public.run_sequence;
create policy run_sequence_delete on public.run_sequence
  for delete using (public.can_approve(tenant_id));

grant select, insert, update, delete on public.run_sequence to authenticated;
grant all on public.run_sequence to service_role;
