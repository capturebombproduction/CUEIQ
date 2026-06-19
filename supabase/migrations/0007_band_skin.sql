-- =====================================================================
-- CueIQ — Phase 2: Per-band skin (each band themes the app)
--
-- groups.skin = a brand hex (e.g. '#A62A1C'); null = no band skin.
-- When set, event pages + the share run sheet of that band are themed to it
-- (server-injected, see lib/accent.ts skinCss). Separate from groups.color
-- (the identity stripe) so a band can have a stripe without theming everything.
--
-- Run in Supabase → SQL Editor (owner). Safe to re-run.
-- (groups already has RLS + grants from 0001 — UPDATE covers the new column.)
-- =====================================================================

alter table public.groups add column if not exists skin text;

-- Expose the band skin to the public share page (extends 0005's reader).
create or replace function public.get_shared_event(p_token uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'id', e.id, 'name', e.name, 'event_date', e.event_date, 'venue', e.venue,
      'event_type', e.event_type, 'show_start_time', e.show_start_time,
      'hard_out_time', e.hard_out_time, 'status', e.status, 'notes', e.notes,
      'map_url', e.map_url, 'costume_theme', e.costume_theme
    ),
    'group', (
      select jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color, 'skin', g.skin)
      from public.groups g where g.id = e.group_id
    ),
    'schedule', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'kind', s.kind, 'label', s.label, 'location', s.location,
        'start_time', s.start_time, 'end_time', s.end_time, 'notes', s.notes,
        'sort_order', s.sort_order
      ) order by s.sort_order)
      from public.schedule_items s where s.event_id = e.id
    ), '[]'::jsonb),
    'setlist', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', si.id, 'kind', si.kind, 'title', si.title,
        'duration_seconds', si.duration_seconds,
        'buffer_before_seconds', si.buffer_before_seconds,
        'buffer_after_seconds', si.buffer_after_seconds,
        'mic_slots', si.mic_slots, 'notes', si.notes, 'sort_order', si.sort_order
      ) order by si.sort_order)
      from public.setlist_items si where si.event_id = e.id
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'name', m.name, 'nickname', m.nickname,
        'mic_number', m.mic_number, 'color', m.color
      ) order by m.sort_order)
      from public.members m where m.group_id = e.group_id
    ), '[]'::jsonb)
  )
  from public.events e
  where e.share_token = p_token and p_token is not null
  limit 1;
$$;

grant execute on function public.get_shared_event(uuid) to anon, authenticated;
