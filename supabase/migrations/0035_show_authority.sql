-- 0035_show_authority.sql
-- Offline-first authority markers (P2): which DEVICE currently holds a live role
-- for an event, so the role survives reloads, syncs across devices, and can be
-- recovered (ghost-main / TTL) — docs/offline-first-plan.md §3/§7.
--   kind = 'show_main'  → the device running the show (timing / notes / run log).
--                         device-claim: first device to "เริ่มโชว์" that day owns it;
--                         handed off by push, force-taken by a higher rank (P3).
--   kind = 'audio_host' → the device that plays the band's audio (device-lock).
-- One holder per (event_id, kind). claimed_at + heartbeat_at drive race tie-break
-- and ghost-main detection; by_user_id / by_role record who claimed (for the P3
-- rank-override decision). This is the SYNCED mirror of each device's local claim;
-- realtime hand-off still rides the existing live: broadcast channel (this table is
-- persistence + join/reconnect/offline-resync truth, not the realtime transport).
--
-- Additive table only — touches nothing existing, safe to apply while bands use prod.
-- Operational coordination is tenant-scoped (matches the existing live model where
-- the app — not the DB — enforces band scope + rank rules; the realtime control
-- channel is likewise tenant-wide). No cross-tenant or master-admin surface added.

create table if not exists public.show_authority (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  event_id      uuid not null references public.events(id) on delete cascade,
  kind          text not null check (kind in ('show_main','audio_host')),
  device_id     text not null,                 -- the holding device (lib/device-id.ts)
  device_label  text,                          -- friendly label for hand-off UI
  by_user_id    uuid references auth.users(id) on delete set null,
  by_role       text,                          -- claimer's rank at claim time (rank override)
  claimed_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  primary key (event_id, kind)
);
create index if not exists show_authority_tenant_idx
  on public.show_authority (tenant_id);

alter table public.show_authority enable row level security;

-- read / claim / heartbeat / release: any tenant member. Band scope + who-may-claim
-- (push hand-off, rank override) are enforced in the app, as with the existing live
-- control channel. A claim is an upsert on (event_id, kind), so insert + update both
-- need the tenant-member check.
drop policy if exists show_authority_select on public.show_authority;
create policy show_authority_select on public.show_authority
  for select using (public.is_tenant_member(tenant_id));
drop policy if exists show_authority_insert on public.show_authority;
create policy show_authority_insert on public.show_authority
  for insert with check (public.is_tenant_member(tenant_id));
drop policy if exists show_authority_update on public.show_authority;
create policy show_authority_update on public.show_authority
  for update using (public.is_tenant_member(tenant_id))
  with check (public.is_tenant_member(tenant_id));
drop policy if exists show_authority_delete on public.show_authority;
create policy show_authority_delete on public.show_authority
  for delete using (public.is_tenant_member(tenant_id));

grant select, insert, update, delete on public.show_authority to authenticated;
grant all on public.show_authority to service_role;
