-- 0054_members_left_at.sql
-- A member who leaves the band is marked, not deleted (2026-10-27, พี่: "ทำสถานะ ออกจากวงแล้ว
-- ให้สมาชิกแทนการลบ (เก็บชื่อในไลน์อัปเก่าและประวัติเช็คชื่อ)").
--
-- Deleting a members row cascades (prod pg_constraint): event_members and
-- practice_attendance go with it (ON DELETE CASCADE), practice_logs.target_member_id is set
-- null - so a member who graduated vanished from every past lineup, run sheet, share page
-- and the practice attendance history. left_at keeps the row: the app hides a left member
-- from pickers and from shows dated after the leaving day (lib/member-status.ts), and keeps
-- them everywhere history is shown.
--
-- get_shared_event: the share page draws the band from 'members', so it gets the same rule
-- (on/before the leaving day, or in the show's lineup). The rest of the function is the
-- prod body read back 2026-10-27 (0039's), unchanged.
--
-- Additive + idempotent. Safe to re-run. Apply with:
--   node --env-file=.env.local scripts/migrate.mjs supabase/migrations/0054_members_left_at.sql

alter table public.members add column if not exists left_at timestamptz;

comment on column public.members.left_at is
  'When the member left the band (null = in the band). Kept for history; see 0054.';

create or replace function public.get_shared_event(p_token uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        -- a member who has LEFT (0054) still shows for a show on or before their leaving
        -- day (Bangkok), and on any show whose lineup holds them; not on later shows
        and (m.left_at is null
             or (e.event_date is not null
                 and e.event_date <= (m.left_at at time zone 'Asia/Bangkok')::date)
             or exists (select 1 from public.event_members em2
                        where em2.event_id = e.id and em2.member_id = m.id))
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
$function$;
