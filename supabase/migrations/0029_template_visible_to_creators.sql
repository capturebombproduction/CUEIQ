-- 0029_template_visible_to_creators.sql
-- "สร้างจากแม่แบบ" must work for the Ar of EVERY band — not just the template's
-- own band (or label-wide roles). A template (is_template = true) is a label-wide
-- baseline: any user who can create an event somewhere in the tenant may now READ
-- it to clone its structure. Nothing about WRITE changes — the clone still lands
-- in a band the user can EDIT, and a cross-band clone already drops song links +
-- mic + audio (band-specific) in the client. This migration only widens READ of
-- the template skeleton (the event row + its schedule/setlist/mic rows).
--
-- RLS permissive SELECT policies are OR'd together, so the new template-scoped
-- policies sit alongside the existing per-band ones without narrowing them.
-- Additive + idempotent. Run with:
--   npm run migrate supabase/migrations/0029_template_visible_to_creators.sql

-- ---------------------------------------------------------------------
-- Helpers (SECURITY DEFINER → bypass RLS, no recursion)
-- ---------------------------------------------------------------------

-- Can the caller create an event for at least one band in the tenant?
-- (tenant admin, OR an Ar of some band in that tenant.)
create or replace function public.can_create_any_event(tid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select coalesce(
    public.can_admin_tenant(tid)
    or exists (
      select 1 from public.group_roles gr
      where gr.tenant_id = tid
        and gr.user_id = auth.uid()
        and gr.role = 'artist_manager'
    ),
    false);
$$;

-- Is this event a template the caller may read (clone-source visibility)?
create or replace function public.can_read_template_event(eid uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = eid
      and e.is_template = true
      and public.can_create_any_event(e.tenant_id)
  );
$$;

grant execute on function public.can_create_any_event(uuid)    to authenticated;
grant execute on function public.can_read_template_event(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Template-scoped SELECT policies (OR'd with the existing per-band ones)
-- ---------------------------------------------------------------------

-- events: any creator in the tenant may read the template row itself.
drop policy if exists events_select_template on public.events;
create policy events_select_template on public.events
  for select using (is_template = true and public.can_create_any_event(tenant_id));

-- event-scoped tables: read the template's skeleton rows (schedule/setlist/mic).
drop policy if exists schedule_items_select_template on public.schedule_items;
create policy schedule_items_select_template on public.schedule_items
  for select using (public.can_read_template_event(event_id));

drop policy if exists setlist_items_select_template on public.setlist_items;
create policy setlist_items_select_template on public.setlist_items
  for select using (public.can_read_template_event(event_id));

drop policy if exists mic_assignments_select_template on public.mic_assignments;
create policy mic_assignments_select_template on public.mic_assignments
  for select using (public.can_read_template_event(event_id));
