-- 0038_round3_hardening.sql
-- Round-3 audit: the DATABASE half of four findings. Each one lets an already-
-- authenticated, trusted-ish account do something the RBAC spec says it may not —
-- three need a crafted API call, C13 is reachable straight from the practice UI —
-- so close them at the source of truth:
--
--   (1) C4  profiles — profiles_update_own (0001) has no column limit, so a member
--       could PATCH their OWN email to the Master Admin address and become both
--       unrevocable and indistinguishable from the master in the admin console.
--   (2) C13 practice_songs / song_markers — writes gate on can_view_group, which is
--       also true for the LABEL-WIDE roles, so a CEO (a read-only observer by spec)
--       could curate every band's practice list and clear their section markers.
--   (3) P5  practice_logs — the UPDATE policy's WITH CHECK never re-asserted band
--       scope, so an author could re-point their own note at another band/event.
--   (4) P6  guard_song_update — denylist drift: id + created_at were never in the
--       approver branch, the exact gap 0037 closed for events.
--
-- Additive + idempotent. Safe to re-run. Run with:
--   npm run migrate supabase/migrations/0038_round3_hardening.sql

-- ---------------------------------------------------------------------
-- (1) C4 — a user may not change their own profiles.email
-- ---------------------------------------------------------------------
-- The Master Admin is identified BY EMAIL everywhere (lib/master-admin.ts,
-- /api/admin/users, the admin console list) and the email it reads comes from the
-- PROFILE row — so a member who set profiles.email = 'architect@cueiq.local' would
-- be refused by every admin write ("บัญชี Master Admin ถูกป้องกันไว้") while showing
-- up as the master. 0020 protects the real account; this closes the impersonation.
--
-- Done as a BEFORE UPDATE guard rather than by tightening profiles_update_own's
-- WITH CHECK: column-level immutability is already this schema's trigger idiom
-- (guard_song_update / guard_event_update / protect_master_membership), and an RLS
-- policy cannot see OLD — pinning the column there would need a self-subquery on
-- profiles from inside profiles' own policy.
--
-- auth.uid() null = service_role / direct connection (the admin API, seeds, the
-- Management API, and handle_new_user's `on conflict do update set email` refresh
-- at signup) — those all keep writing, exactly like 0037's insert guard. Nothing in
-- the app writes public.profiles as the signed-in user today (grep: the only
-- writers are the service-role admin routes, which only SELECT it, and the signup
-- trigger), so freezing the column costs no working path.
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if auth.uid() is not null
     and old.id = auth.uid()                      -- the caller's OWN row
     and new.email is distinct from old.email
  then
    raise exception 'a user may not change their own email';
  end if;
  return new;
end; $$;

drop trigger if exists profiles_guard_update on public.profiles;
create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------------------------------------------------------------------
-- (2) C13 — practice writes are BAND-scoped, not label-wide
-- ---------------------------------------------------------------------
-- 0030/0031 deliberately let any band MEMBER curate the practice list and mark song
-- sections (unlike the editor-only show setlist) and expressed that as
-- can_view_group. But can_view_group is ALSO true for the label-wide roles
-- (is_label_wide → ceo, label_staff), so a CEO — a read-only observer by the RBAC
-- spec — could add/remove practice songs and clear section markers for EVERY band.
-- The right gate is the band itself: an editor (admin / the band's Ar, via
-- can_edit_group) OR anyone holding a group_roles row for that band (its members).
-- Members + Ar keep exactly the write they have today; only the label-wide
-- observers lose it.
--
-- ⚠️ written as `group_id in (select gr.group_id ...)` on purpose: inside an
-- `exists (... where gr.group_id = group_id)` the bare outer column would bind to
-- group_roles.group_id (inner scope wins) and match ANY band. The sub-select only
-- ever returns the caller's own rows, which group_roles_select (0016) already
-- exposes, so it resolves under RLS without recursion.
-- SELECT is untouched: practice_songs_select / song_markers_select are separate
-- permissive policies, and permissive policies are OR'd.

drop policy if exists practice_songs_insert on public.practice_songs;
create policy practice_songs_insert on public.practice_songs
  for insert with check (
    public.can_edit_group(group_id)
    or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
  );

drop policy if exists practice_songs_update on public.practice_songs;
create policy practice_songs_update on public.practice_songs
  for update using (
    public.can_edit_group(group_id)
    or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
  )
  with check (
    public.can_edit_group(group_id)
    or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
  );

drop policy if exists practice_songs_delete on public.practice_songs;
create policy practice_songs_delete on public.practice_songs
  for delete using (
    public.can_edit_group(group_id)
    or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
  );

drop policy if exists song_markers_write on public.song_markers;
create policy song_markers_write on public.song_markers
  for all using (
    public.can_edit_group(group_id)
    or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
  )
  with check (
    public.can_edit_group(group_id)
    or group_id in (select gr.group_id from public.group_roles gr where gr.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- (3) P5 — practice_logs UPDATE must re-assert band scope on the NEW row
-- ---------------------------------------------------------------------
-- 0024's WITH CHECK only repeated the USING clause, which is about WHO may write,
-- not WHERE the row may land — so an author could update their own note and move it
-- (group_id / event_id / tenant_id) into a band they may not touch, or — as a plain
-- member — promote it to visibility = 'staff', which INSERT never let them create.
-- Mirror the INSERT scoping. USING is unchanged (the author, or any band editor), and
-- author_id stays out of the check so an Ar can still edit a member's note.
drop policy if exists practice_logs_update on public.practice_logs;
create policy practice_logs_update on public.practice_logs
  for update using (author_id = auth.uid() or public.can_edit_group(group_id))
  with check (
    (author_id = auth.uid() or public.can_edit_group(group_id))
    and public.can_view_group(group_id)
    and (visibility = 'shared' or public.can_edit_group(group_id))
  );

-- ---------------------------------------------------------------------
-- (4) P6 — songs column guard: id + created_at join the approver denylist
-- ---------------------------------------------------------------------
-- Same drift 0037 fixed for events: the approver-only branch is a DENYLIST (songs
-- has updated_at + a touch_updated_at BEFORE trigger, so a whole-row compare would
-- always trip), and id + created_at have been missing from it since 0018 — a
-- label_staff could rewrite a song's identity/creation time while "only" clearing
-- copyright. copyright_status + updated_at stay the only allowed deltas. When a
-- future migration adds a column to songs, add it here too.
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
    or new.audio_expires_at is distinct from old.audio_expires_at
    or new.id               is distinct from old.id               -- 0002 (missed by 0018)
    or new.created_at       is distinct from old.created_at;      -- 0002 (missed by 0018)
  if other_changed and not is_editor then
    raise exception 'only an editor may change song details';
  end if;
  return new;
end; $$;
