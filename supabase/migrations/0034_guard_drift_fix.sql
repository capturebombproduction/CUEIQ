-- 0034_guard_drift_fix.sql
-- Defense-in-depth fixes for "denylist drift" + one loose insert policy. All three
-- only bite a crafted API call by an authenticated, trusted-ish role (label_staff),
-- and are moot on the current single-tenant deployment — but they violate the stated
-- invariants, so close them.
--
--   (1) guard_event_update — the approver-only column guard (0018) is a DENYLIST.
--       is_template (0019) + is_practice (0022) were added to events AFTER it, so a
--       non-editor approver could flip a real show into a template/practice record
--       (hiding it from lists / reminders). Add them to the list.
--   (2) guard_song_update  — same class: bpm (0025) was added to songs after the
--       0018 guard, so a non-editor approver could change a song's tempo. Add it.
--   (3) client_errors_insert — checked only user_id = auth.uid(); a user could log
--       error rows tagged with ANOTHER tenant_id (cross-tenant noise). Scope it to
--       the caller's own tenant, but still allow a NULL tenant (errors fired before
--       the workspace resolves are self-reported with no tenant — must keep logging).
--
-- ⚠️ events + songs both have updated_at + a touch_updated_at BEFORE trigger, so these
-- guards MUST stay column-denylists (a whole-row compare would always trip on
-- updated_at). When a future migration adds a column to events/songs, add it here too.
-- Additive + idempotent. Run with: npm run migrate supabase/migrations/0034_guard_drift_fix.sql

-- ---------------------------------------------------------------------
-- (1) events column guard — approver-only may change ONLY status
-- ---------------------------------------------------------------------
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
       or new.is_template      is distinct from old.is_template   -- 0019 (added 0034)
       or new.is_practice      is distinct from old.is_practice   -- 0022 (added 0034)
       or new.group_id         is distinct from old.group_id
       or new.tenant_id        is distinct from old.tenant_id
    then
      raise exception 'label_staff may only change event status';
    end if;
    return new;
  end if;
  raise exception 'not allowed to update this event';
end; $$;

-- ---------------------------------------------------------------------
-- (2) songs column guard — copyright_status approver-only; rest editor-only
-- ---------------------------------------------------------------------
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
    or new.bpm              is distinct from old.bpm              -- 0025 (added 0034)
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

-- ---------------------------------------------------------------------
-- (3) client_errors insert — own user AND own tenant (or no tenant)
-- ---------------------------------------------------------------------
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors
  for insert with check (
    user_id = auth.uid()
    and (tenant_id is null or public.is_tenant_member(tenant_id))
  );
