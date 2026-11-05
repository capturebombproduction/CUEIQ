-- Read-only proof for 0055_event_rls_sets.sql: the per-row event checks and the set-based
-- ones agree for every user x every event. Raises EQUIV_RESULT ... mismatches=NONE on success.
--   node --env-file=.env.local scripts/query.mjs "$(cat scripts/rls-equiv-0055.sql)"
begin read only;
do $$
declare
  u uuid;
  users uuid[];
  bad text := '';
  checked int := 0;
  ids uuid[];
  e uuid;
  old_v boolean; new_v boolean;
  old_t boolean; new_t boolean;
  old_e boolean; new_e boolean;
  vis int := 0; tmpl int := 0; edit int := 0;
begin
  -- every user + anon (null) + a stranger with no rows anywhere
  select array_agg(id) into users from auth.users;
  users := users || array[null::uuid, gen_random_uuid()];
  -- every event id, plus one that does not exist and a null
  select array_agg(id) into ids from public.events;
  ids := ids || array[gen_random_uuid(), null::uuid];
  foreach u in array users loop
    if u is null then
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    else
      perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    end if;
    foreach e in array ids loop
      -- the per-row functions the policies call today
      old_v := coalesce(public.can_view_event(e), false);
      old_t := coalesce(public.can_read_template_event(e), false);
      old_e := coalesce(public.can_edit_event(e), false);
      -- the set-based bodies proposed for 0055 (computed once per statement)
      new_v := coalesce(e in (select ev.id from public.events ev
                 where ev.group_id in (select g.id from public.groups g where public.can_view_group(g.id))), false);
      new_t := coalesce(e in (select ev.id from public.events ev
                 where ev.is_template = true and public.can_create_any_event(ev.tenant_id)), false);
      new_e := coalesce(e in (select ev.id from public.events ev
                 where ev.group_id in (select g.id from public.groups g where public.can_edit_group(g.id))), false);
      checked := checked + 1;
      if old_v then vis := vis + 1; end if;
      if old_t then tmpl := tmpl + 1; end if;
      if old_e then edit := edit + 1; end if;
      if old_v <> new_v or old_t <> new_t or old_e <> new_e then
        bad := bad || format('[user %s event %s: view %s/%s template %s/%s edit %s/%s] ',
          coalesce(u::text, 'anon'), coalesce(e::text, 'null'), old_v, new_v, old_t, new_t, old_e, new_e);
      end if;
    end loop;
  end loop;
  raise exception 'EQUIV_RESULT users=% pairs=% true_view=% true_template=% true_edit=% mismatches=%',
    array_length(users, 1), checked, vis, tmpl, edit, case when bad = '' then 'NONE' else bad end;
end $$;
