-- 0055_event_rls_sets.sql
-- PERFORMANCE ONLY - who can see or write which row does not change (proved on prod data below).
--
-- Measured 2026-11-05 (pg_stat_statements since 2026-06-16 + EXPLAIN ANALYZE as a real user):
-- the slowest reads in the whole app were the tenant-wide reads of schedule_items /
-- setlist_items / event_members (the Overview, the dashboard's run status, the run-order
-- page): mean 82-280 ms, max 927 ms, for tables of a few hundred rows. The cause is the
-- policies: `can_view_event(event_id)` OR `can_read_template_event(event_id)` OR
-- `can_edit_event(event_id)` (the ALL policy applies to SELECT too) run FOR EVERY ROW, and
-- each one is a SECURITY DEFINER function (never inlined) that looks the event up and calls
-- can_view_group / can_edit_group / can_create_any_event in turn.
--   EXPLAIN, a band member, schedule_items of the tenant: 315 ms, 5,522 buffers, 18 rows of 347.
--   The same filter written as sets computed ONCE per statement (hashed SubPlans): 6.8 ms,
--   395 buffers, the same 18 rows. An admin (every row visible): 112 ms / 118 ms today.
--
-- So each policy keeps its name, command, roles and meaning, and asks "is event_id in the set
-- of events this user may see / edit / read as a template" instead of re-deriving it per row:
--   can_view_event(eid)          = exists (events e where e.id = eid and can_view_group(e.group_id))
--   viewable_event_ids()         = { e.id | e in events, e.group_id in { g.id | can_view_group(g.id) } }
-- and the same for edit (can_edit_group) and templates (is_template and can_create_any_event).
-- Same sets by construction; a null or unknown event_id is in none of them, as before.
-- Proved on prod 2026-11-05 (read-only DO block, scripts/rls-equiv-0055.sql): every user in
-- auth.users (19) + anon + a stranger, x every event id (71) + an unknown id + null = 1,533
-- pairs, old function vs new set for view / template / edit: 0 mismatches.
--
-- Scope: only the three tables read tenant-wide. mic_assignments, setlist_versions and
-- show_authority keep the per-row functions (tiny, always read by one event_id).
-- The old functions stay: other policies and RPCs still call them.
--
-- GRANTS: in this database a function postgres creates does NOT get PUBLIC execute by
-- default (pg_default_acl), but the functions the policies call today do (=X/postgres).
-- Without the grants below every anon read of these tables (supabase-js sends the anon key
-- for a moment after a wake) would fail with "permission denied" instead of answering no
-- rows - a different failure than every reader of these tables was written for.
--
-- One transaction: a policy dropped and not yet re-created would answer reads with no rows.
-- Idempotent; safe to re-run. Apply with (only on พี่'s word, never before a show):
--   node --env-file=.env.local scripts/migrate.mjs supabase/migrations/0055_event_rls_sets.sql
-- Undo = re-create the six policies with the per-row functions (0016's text, in each comment).

begin;

create or replace function public.viewable_event_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id from public.events e
  where e.group_id in (select g.id from public.groups g where public.can_view_group(g.id));
$function$;

create or replace function public.editable_event_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id from public.events e
  where e.group_id in (select g.id from public.groups g where public.can_edit_group(g.id));
$function$;

create or replace function public.readable_template_event_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select e.id from public.events e
  where e.is_template = true and public.can_create_any_event(e.tenant_id);
$function$;

-- the same privileges as can_view_event & co. have today ({=X, postgres, authenticated, service_role})
grant execute on function public.viewable_event_ids() to public, authenticated, service_role;
grant execute on function public.editable_event_ids() to public, authenticated, service_role;
grant execute on function public.readable_template_event_ids() to public, authenticated, service_role;

-- schedule_items (was: _select using can_view_event(event_id); _select_template using
-- can_read_template_event(event_id); _write for all using + with check can_edit_event(event_id))
drop policy if exists schedule_items_select on public.schedule_items;
create policy schedule_items_select on public.schedule_items for select
  using (event_id in (select public.viewable_event_ids()));
drop policy if exists schedule_items_select_template on public.schedule_items;
create policy schedule_items_select_template on public.schedule_items for select
  using (event_id in (select public.readable_template_event_ids()));
drop policy if exists schedule_items_write on public.schedule_items;
create policy schedule_items_write on public.schedule_items for all
  using (event_id in (select public.editable_event_ids()))
  with check (event_id in (select public.editable_event_ids()));

-- setlist_items (same three as schedule_items)
drop policy if exists setlist_items_select on public.setlist_items;
create policy setlist_items_select on public.setlist_items for select
  using (event_id in (select public.viewable_event_ids()));
drop policy if exists setlist_items_select_template on public.setlist_items;
create policy setlist_items_select_template on public.setlist_items for select
  using (event_id in (select public.readable_template_event_ids()));
drop policy if exists setlist_items_write on public.setlist_items;
create policy setlist_items_write on public.setlist_items for all
  using (event_id in (select public.editable_event_ids()))
  with check (event_id in (select public.editable_event_ids()));

-- event_members (was: _select using can_view_event(event_id); _write for all using + with
-- check can_edit_event(event_id); no template policy)
drop policy if exists event_members_select on public.event_members;
create policy event_members_select on public.event_members for select
  using (event_id in (select public.viewable_event_ids()));
drop policy if exists event_members_write on public.event_members;
create policy event_members_write on public.event_members for all
  using (event_id in (select public.editable_event_ids()))
  with check (event_id in (select public.editable_event_ids()));

commit;
