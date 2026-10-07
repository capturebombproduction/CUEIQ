-- 0046_show_authority_server_stamp.sql
-- show_authority, two holes found in the 2026-10-07 review (both in 0035):
--
-- 1. heartbeat_at was the CLIENT's clock. isGhost (lib/show-authority.ts) treats a
--    heartbeat in the future as alive, so a row stamped "2099-01-01" - written on
--    purpose, or by a device whose clock ran far ahead and then crashed - refused
--    START on every device of that show, and nothing in the app clears it. The
--    server now stamps heartbeat_at (and claimed_at on a claim) itself. That is the
--    "real fix" lib/show-authority.ts describes; its symmetric grace stays (the
--    observer's clock is still its own).
-- 2. Any account in the tenant could write any event's row (is_tenant_member only):
--    a member of another band could hold a show's MAIN. Writing now needs
--    can_view_event - exactly who can open that show's Live page. Reading stays
--    tenant-wide (the festival run order reads other bands' rows).
--
-- Also pinned on the server: tenant_id = the event's tenant, by_user_id = the caller.
-- Old desktop builds keep working: they send their own stamps, which are replaced.

create or replace function public.stamp_show_authority()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  new.heartbeat_at := now();
  if tg_op = 'INSERT' then
    new.claimed_at := now();
  elsif new.claimed_at is distinct from old.claimed_at
     or new.device_id is distinct from old.device_id then
    new.claimed_at := now(); -- a claim (upsert); a heartbeat leaves claimed_at alone
  end if;
  new.tenant_id := coalesce(
    (select e.tenant_id from public.events e where e.id = new.event_id),
    new.tenant_id
  );
  if auth.uid() is not null then
    new.by_user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_show_authority on public.show_authority;
create trigger stamp_show_authority
  before insert or update on public.show_authority
  for each row execute function public.stamp_show_authority();

-- a row already stamped in the future (none expected) is brought back to now
update public.show_authority set heartbeat_at = now() where heartbeat_at > now();

drop policy if exists show_authority_insert on public.show_authority;
create policy show_authority_insert on public.show_authority
  for insert with check (
    public.is_tenant_member(tenant_id) and public.can_view_event(event_id)
  );
drop policy if exists show_authority_update on public.show_authority;
create policy show_authority_update on public.show_authority
  for update using (public.can_view_event(event_id))
  with check (public.is_tenant_member(tenant_id) and public.can_view_event(event_id));
drop policy if exists show_authority_delete on public.show_authority;
create policy show_authority_delete on public.show_authority
  for delete using (public.can_view_event(event_id));
