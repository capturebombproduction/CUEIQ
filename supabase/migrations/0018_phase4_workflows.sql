-- 0018_phase4_workflows.sql
-- Phase 4 (approval workflows) DB layer. Two correctness fixes on top of the
-- 0016 RBAC model, both defense-in-depth at the DB (the UI already mirrors them):
--   (1) events: approvers (label_staff) may change ONLY events.status. 0016 left
--       events write = can_edit_group only, so the overview approve/reject buttons
--       silently failed RLS for label_staff (songs had the approver path, events
--       did not). Mirror the songs pattern: update = editor OR approver + a column
--       guard limiting approvers to `status`. Insert/delete stay editor-only.
--   (2) songs: tighten copyright governance. copyright_status may be changed by
--       APPROVERS ONLY (0016's guard let a band's Ar — a full editor — change it,
--       i.e. self-clear their own copyright); other song columns stay editor-only;
--       and new songs created by non-approvers are forced to 'pending'.

-- ---------------------------------------------------------------------
-- (1) events — approver may change status
-- ---------------------------------------------------------------------
drop policy if exists events_write on public.events;

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert with check (public.can_edit_group(group_id));

drop policy if exists events_delete on public.events;
create policy events_delete on public.events
  for delete using (public.can_edit_group(group_id));

drop policy if exists events_update on public.events;
create policy events_update on public.events
  for update
  using (public.can_edit_group(group_id) or public.can_approve(tenant_id))
  with check (public.can_edit_group(group_id) or public.can_approve(tenant_id));

-- Column guard: an approver who is NOT a band editor may change ONLY status.
create or replace function public.guard_event_update()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if public.can_edit_group(new.group_id) then
    return new;                                -- full editor (admin / Ar): anything
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
       or new.group_id         is distinct from old.group_id
       or new.tenant_id        is distinct from old.tenant_id
    then
      raise exception 'label_staff may only change event status';
    end if;
    return new;
  end if;
  raise exception 'not allowed to update this event';
end; $$;

drop trigger if exists events_guard_update on public.events;
create trigger events_guard_update
  before update on public.events
  for each row execute function public.guard_event_update();

-- ---------------------------------------------------------------------
-- (2) songs — copyright_status is approver-only; force new songs to pending
-- ---------------------------------------------------------------------
-- Replaces the 0016 guard: separate the two axes — copyright_status needs an
-- approver, every other column needs an editor (admin satisfies both).
create or replace function public.guard_song_update()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  is_editor   boolean := public.can_edit_group(new.group_id);
  is_approver boolean := public.can_approve(new.tenant_id);
  other_changed boolean;
begin
  if not (is_editor or is_approver) then
    raise exception 'not allowed to update this song';
  end if;
  -- copyright_status: approver-only (an Ar can no longer self-clear)
  if new.copyright_status is distinct from old.copyright_status and not is_approver then
    raise exception 'only an approver may change copyright_status';
  end if;
  -- everything else: editor-only
  other_changed :=
       new.title            is distinct from old.title
    or new.file_name        is distinct from old.file_name
    or new.duration_seconds is distinct from old.duration_seconds
    or new.language         is distinct from old.language
    or new.category         is distinct from old.category
    or new.notes            is distinct from old.notes
    or new.group_id         is distinct from old.group_id
    or new.tenant_id        is distinct from old.tenant_id
    or new.audio_path       is distinct from old.audio_path
    or new.audio_name       is distinct from old.audio_name
    or new.audio_expires_at is distinct from old.audio_expires_at;
  if other_changed and not is_editor then
    raise exception 'only an editor may change song details';
  end if;
  return new;
end; $$;

-- New songs always start 'pending' unless created by an approver (admin / label_staff
-- may set an initial status explicitly). Bands can't upload a pre-cleared song.
create or replace function public.force_song_pending_on_insert()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if not public.can_approve(new.tenant_id) then
    new.copyright_status := 'pending';
  end if;
  return new;
end; $$;

drop trigger if exists songs_force_pending_insert on public.songs;
create trigger songs_force_pending_insert
  before insert on public.songs
  for each row execute function public.force_song_pending_on_insert();
