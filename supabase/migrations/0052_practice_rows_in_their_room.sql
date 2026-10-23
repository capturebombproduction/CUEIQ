-- 0052_practice_rows_in_their_room.sql
-- Three server-side holes from the 2026-10-17 review list, re-measured on prod 2026-10-24
-- (every practice row on prod already sits in its own band's room - nothing to repair):
--
-- 1. A practice row's room was never tied to its band. practice_songs / _logs /
--    _attendance / _runs carry BOTH event_id (the room) and group_id (the band), and
--    every insert policy (0038, 0041) checks group_id only. So a member of band A could
--    write a row "of band A" into band B's room - or into a real show - with a crafted
--    request: invisible to B (select gates on group_id), but it holds B's
--    unique (event_id, song_id) slot, so B could no longer add that song to its own
--    set, and nobody in B can see or delete what blocks it. The app always writes the
--    room's own band (the practice page loads only that band's songs, and the route
--    refuses a non-practice event), so the rule below changes nothing it does.
--
-- 2. A room that moved band left its rows behind. events.group_id CAN change (the
--    event form's band picker; an admin, or an Ar of both bands). Every practice row
--    kept the old band: the new band's members opened their room to an empty list and
--    journal, while the old band still read them. Rows now follow their room.
--
-- 3. An Ar could write a show's run time. "จบโชว์" / "ล้าง" (the run-time record on
--    the events list) are admin-only in the app (lib/permissions.ts canLiveEdit), but
--    guard_event_update let every full editor change last_run_seconds/last_run_at, so
--    an Ar's crafted PATCH could rewrite it. Now: an admin only. A non-admin's INSERT
--    carrying a run time gets it cleared (nothing in the app sends one - a new or
--    cloned event never has a run yet), the way 0037 turns 'approved' into 'draft'.
--
-- Looked at and left alone (same review list):
--   • templates readable by every band's Ar - deliberate, 0029 ("a label-wide baseline").
--   • label_staff cannot DELETE a photo schedule row - nothing asks it to: the Overview
--     photo cell clears a time with an UPDATE, which 0016's photo policies allow.
--     Granting a delete would only widen label_staff.
--   • a feedback author can delete their own screenshot - their own report.
--
-- Additive + idempotent (create or replace / drop … if exists). Safe to re-run. Apply with:
--   node --env-file=.env.local scripts/migrate.mjs supabase/migrations/0052_practice_rows_in_their_room.sql

-- ---------------------------------------------------------------------
-- 1. A practice row lives in its own band's practice room
-- ---------------------------------------------------------------------
-- A trigger, not the RLS policies: it holds for every writer (the four tables' insert
-- and update policies differ, and service-role scripts write here too) and it can see
-- OLD. SECURITY DEFINER so the room lookup does not depend on the writer's own view
-- of events.
--   INSERT: the room exists, is a practice room, and is in the row's band + tenant.
--           A practice_runs row with no room (0051 keeps history after a room's
--           delete) only needs its band to be in its tenant.
--   UPDATE: a row never changes room. The one event_id change allowed is to NULL - the
--           FK's ON DELETE SET NULL when a room is deleted (practice_runs, 0051).
--           group_id / tenant_id may change only to follow the room (section 2).
--           A row whose band and room are untouched is not re-checked, so an edit of a
--           row that drifted before this migration still saves.
create or replace function public.practice_row_in_its_room()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id and new.event_id is not null then
      raise exception 'a practice row cannot move to another room'
        using errcode = '42501';
    end if;
    if new.group_id is not distinct from old.group_id
       and new.tenant_id is not distinct from old.tenant_id then
      return new;
    end if;
    if new.event_id is null or not exists (
      select 1 from public.events e
      where e.id = new.event_id
        and e.group_id = new.group_id
        and e.tenant_id = new.tenant_id
    ) then
      raise exception 'a practice row''s band follows its room'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.event_id is null then
    if not exists (
      select 1 from public.groups g
      where g.id = new.group_id and g.tenant_id = new.tenant_id
    ) then
      raise exception 'a practice row''s band must be in its tenant'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if not exists (
    select 1 from public.events e
    where e.id = new.event_id
      and e.is_practice is true
      and e.group_id = new.group_id
      and e.tenant_id = new.tenant_id
  ) then
    raise exception 'a practice row belongs in its own band''s practice room'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists practice_songs_in_its_room on public.practice_songs;
create trigger practice_songs_in_its_room
  before insert or update on public.practice_songs
  for each row execute function public.practice_row_in_its_room();

drop trigger if exists practice_logs_in_its_room on public.practice_logs;
create trigger practice_logs_in_its_room
  before insert or update on public.practice_logs
  for each row execute function public.practice_row_in_its_room();

drop trigger if exists practice_attendance_in_its_room on public.practice_attendance;
create trigger practice_attendance_in_its_room
  before insert or update on public.practice_attendance
  for each row execute function public.practice_row_in_its_room();

drop trigger if exists practice_runs_in_its_room on public.practice_runs;
create trigger practice_runs_in_its_room
  before insert or update on public.practice_runs
  for each row execute function public.practice_row_in_its_room();

-- ---------------------------------------------------------------------
-- 2. When a room moves band, its rows move with it
-- ---------------------------------------------------------------------
-- AFTER the guard has allowed the move (events_guard_update). The rows' updates pass
-- section 1 because their new band is their room's band. The songs a moved room lists
-- stay the OLD band's songs (songs are per band) - the new band sees those entries
-- only once it has the songs; nothing is deleted.
create or replace function public.practice_rows_follow_their_room()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  update public.practice_songs set group_id = new.group_id
    where event_id = new.id and group_id is distinct from new.group_id;
  update public.practice_logs set group_id = new.group_id
    where event_id = new.id and group_id is distinct from new.group_id;
  update public.practice_attendance set group_id = new.group_id
    where event_id = new.id and group_id is distinct from new.group_id;
  update public.practice_runs set group_id = new.group_id
    where event_id = new.id and group_id is distinct from new.group_id;
  return null;
end;
$$;

drop trigger if exists practice_rows_follow_their_room on public.events;
create trigger practice_rows_follow_their_room
  after update of group_id on public.events
  for each row when (old.group_id is distinct from new.group_id)
  execute function public.practice_rows_follow_their_room();

-- Rows a room left behind before this migration (none on prod 2026-10-24) rejoin it.
update public.practice_songs x set group_id = e.group_id
  from public.events e where e.id = x.event_id and x.group_id is distinct from e.group_id;
update public.practice_logs x set group_id = e.group_id
  from public.events e where e.id = x.event_id and x.group_id is distinct from e.group_id;
update public.practice_attendance x set group_id = e.group_id
  from public.events e where e.id = x.event_id and x.group_id is distinct from e.group_id;
update public.practice_runs x set group_id = e.group_id
  from public.events e where e.id = x.event_id and x.group_id is distinct from e.group_id;

-- ---------------------------------------------------------------------
-- 3. A show's run time is an admin's record
-- ---------------------------------------------------------------------
-- guard_event_update exactly as 0037 left it, plus the last_run check in the full-editor
-- branch (the label_staff branch already refuses any last_run change).
create or replace function public.guard_event_update()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if public.can_edit_group(new.group_id) then
    -- full editor (admin / Ar): anything EXCEPT approving — that needs an approver
    if new.tenant_id is distinct from old.tenant_id then
      raise exception 'an event may not change tenant';
    end if;
    if new.status is distinct from old.status
       and new.status = 'approved'
       and not public.can_approve(old.tenant_id)   -- the tenant the row IS in
    then
      raise exception 'only an approver may approve an event';
    end if;
    -- 0052: จบโชว์ / ล้าง are admin-only in the app (canLiveEdit) - and on the server
    if (new.last_run_seconds is distinct from old.last_run_seconds
        or new.last_run_at is distinct from old.last_run_at)
       and not public.can_admin_tenant(old.tenant_id)
    then
      raise exception 'only an admin may record a show''s run time';
    end if;
    return new;
  end if;
  if public.can_approve(new.tenant_id) then    -- approver-only (label_staff): status only
    if new.name             is distinct from old.name
       or new.event_date       is distinct from old.event_date
       or new.venue            is distinct from old.venue
       or new.event_type       is distinct from old.event_type
       or new.show_start_time  is distinct from old.show_start_time
       or new.hard_out_time    is distinct from old.hard_out_time
       or new.notes            is distinct from old.notes
       or new.map_url          is distinct from old.map_url
       or new.costume_theme    is distinct from old.costume_theme
       or new.share_token      is distinct from old.share_token
       or new.share_expires_at is distinct from old.share_expires_at
       or new.deadline         is distinct from old.deadline
       or new.deadline_note    is distinct from old.deadline_note
       or new.last_run_seconds is distinct from old.last_run_seconds
       or new.last_run_at      is distinct from old.last_run_at
       or new.is_template      is distinct from old.is_template   -- 0019 (added 0034)
       or new.is_practice      is distinct from old.is_practice   -- 0022 (added 0034)
       or new.group_id         is distinct from old.group_id
       or new.tenant_id        is distinct from old.tenant_id
       or new.id               is distinct from old.id          -- 0001 (missed by 0018)
       or new.created_by       is distinct from old.created_by  -- 0001 (missed by 0018)
       or new.created_at       is distinct from old.created_at  -- 0001 (missed by 0018)
    then
      raise exception 'label_staff may only change event status';
    end if;
    return new;
  end if;
  raise exception 'not allowed to update this event';
end; $$;

-- The insert side, as 0037 does for 'approved': a non-admin's new event starts with no
-- run time. auth.uid() is null for service-role scripts, which keep what they send.
create or replace function public.force_event_unapproved_on_insert()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if new.status = 'approved'
     and auth.uid() is not null
     and not public.can_approve(new.tenant_id)
  then
    new.status := 'draft';
  end if;
  if (new.last_run_seconds is not null or new.last_run_at is not null)
     and auth.uid() is not null
     and not public.can_admin_tenant(new.tenant_id)
  then
    new.last_run_seconds := null;
    new.last_run_at := null;
  end if;
  return new;
end; $$;
