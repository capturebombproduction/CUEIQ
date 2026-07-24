-- 0037_event_approval_guard.sql
-- Close the event self-approval hole: a band's Ar (full editor via can_edit_group)
-- could set events.status = 'approved' with a crafted API call — the UI only shows
-- อนุมัติ/ปฏิเสธ to approvers, but neither RLS nor the 0018/0034 column guard
-- restricted WHICH status an editor may set. That bypasses the whole
-- submit → review → approve workflow AND silences the deadline-reminder cron
-- (it skips status = 'approved'). The songs guard was tightened for exactly this
-- class in 0018 ("an Ar can no longer self-clear" copyright_status); mirror it:
--   (1) guard_event_update — editor path: transition INTO 'approved' now needs
--       public.can_approve (admin / label_staff). Every other editor write is
--       untouched — draft ↔ pending_review auto-transitions, rejected →
--       pending_review resubmit, and non-status edits of an already-approved
--       event (new.status not distinct from old) all keep working, so the
--       desktop outbox flush (full-payload PATCH with the user's token) is safe.
--       That right is judged on old.tenant_id, and the editor path now also
--       refuses a tenant_id change: tenant_id is writable by an editor, so
--       keying on new.tenant_id would let ONE update move the row into a tenant
--       where the caller happens to be an approver and self-approve it there.
--   (2) new insert guard — the same hole at creation: a non-approver could
--       insert an event born 'approved'. Force it to 'draft' (like
--       force_song_pending_on_insert). SKIPPED when auth.uid() is null so
--       service_role / direct-connection seeding keeps inserting any status.
--
-- ⚠️ events has updated_at + a touch_updated_at BEFORE trigger, so the approver-only
-- branch MUST stay a column-denylist. The 0034 list is carried over PLUS id,
-- created_by and created_at, which it has been missing since 0018 (a label_staff
-- could rewrite who created a show); status + updated_at stay the only allowed
-- deltas. When a future migration adds a column to events, add it here too.
-- Additive + idempotent. Run with: npm run migrate supabase/migrations/0037_event_approval_guard.sql

-- ---------------------------------------------------------------------
-- (1) events column guard — editors may NOT transition status to 'approved'
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- (2) events insert guard — non-approvers can't create a pre-approved event
-- ---------------------------------------------------------------------
-- auth.uid() null = service_role / direct connection (seeds, Mgmt API) — leave the
-- row alone; RLS already blocks anonymous inserts, so no end-user reaches that path.
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
  return new;
end; $$;

drop trigger if exists events_force_unapproved_insert on public.events;
create trigger events_force_unapproved_insert
  before insert on public.events
  for each row execute function public.force_event_unapproved_on_insert();
