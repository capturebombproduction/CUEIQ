-- =====================================================================
-- CueIQ — Share sheet: this show's LINEUP (who actually performs)
--
-- The public run sheet printed the band's ENTIRE roster as this show's members,
-- because the reader never returned event_members (0006) — a show where 5 of 8
-- members are on looked identical to one where everyone is, so the venue set out
-- 8 mic stands and the MC prepared intros for people who were not there.
--
-- 'lineup' = the member ids on THIS event. [] keeps 0006's rule ("no rows yet =
-- lineup not chosen"), which the page reads as "everyone is on" — same output as
-- before this migration, so nothing regresses for events that never picked one.
--
-- Extends 0010's reader: identical body (token + expiry checks unchanged), one
-- new key. It exposes nothing further — the ids are a SUBSET of the 'members'
-- array this reader already returns (the join pins them to this event's band),
-- so an anonymous token holder only learns which of those members are on.
--
-- Additive + idempotent, a single implicit transaction. Safe to re-run.
-- Run via: npm run migrate supabase/migrations/0039_share_lineup.sql
-- =====================================================================

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
    ), '[]'::jsonb),
    -- ids only, and only ids that are already in 'members' above — the join to
    -- members (same group filter) is what guarantees that, so a stray lineup row
    -- pointing at another band's member can never leak an unrelated id.
    'lineup', coalesce((
      select jsonb_agg(em.member_id order by m.sort_order)
      from public.event_members em
      join public.members m on m.id = em.member_id
      where em.event_id = e.id and m.group_id = e.group_id
    ), '[]'::jsonb)
  )
  from public.events e
  where e.share_token = p_token and p_token is not null
    and (e.share_expires_at is null or e.share_expires_at > now())
  limit 1;
$$;

grant execute on function public.get_shared_event(uuid) to anon, authenticated;
