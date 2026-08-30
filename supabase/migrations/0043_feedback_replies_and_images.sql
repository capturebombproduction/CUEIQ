-- 0043 — THE FEEDBACK CHANNEL LEARNS TO ANSWER BACK, AND TO CARRY A PICTURE.
--
-- Round 13 read `public.feedback` for the first time and found five notes, the
-- oldest from 27 June, every one of them status=open and NONE of them ever
-- answered. Three real fixes came out of that reading — it was the best source of
-- work the project has — and the person who wrote each note has still never heard
-- a word back. A channel that only listens goes quiet, so this migration gives the
-- table the two things the label asked for by name:
--
--   1. A REPLY. `reply` / `replied_at` / `replied_by`, written by an admin in the
--      Dev Inbox and read by the author in "ที่ส่งไปแล้ว". No new SELECT policy is
--      needed: feedback_select already reads `user_id = auth.uid() or
--      can_admin_tenant(tenant_id)`, which is exactly "the author, or an admin".
--
--   2. PICTURES. `images text[]` holds R2 OBJECT KEYS (never URLs — same rule as
--      songs.audio_path), under `<tenant>/feedback/<author>/<random>.<ext>`. The
--      author's own id is IN the key, so /api/audio/presign can authorize an
--      attachment from the key shape alone and land on the same answer the RLS
--      policy above would give, with no extra read. Asked for on 2026-08-13:
--      "แล้วก็อยากให้สามารถเพิ่มรูปในที่ส่งฟีดแบคได้".
--
--   3. `reply_seen_at` — so the author's unread dot is a fact about the ACCOUNT
--      and not about the browser they happened to read it in.
--
-- (3) is the only one that needs the policy touched, and it is the delicate part:
-- until now a member could not UPDATE their own feedback row AT ALL, which is what
-- stopped them rewriting a message after an admin had triaged it. That property is
-- worth keeping. So the policy widens to let the author update their own row, and
-- a guard trigger — the house pattern, cf. guard_profile_update (0038) and
-- guard_song_update (0016/0034/0038) — narrows it right back down to the single
-- column they are allowed to touch.
--
-- ⚠️ THE TRIGGER IS DELIBERATELY STRICT ABOUT service_role. Under the service key
-- auth.uid() is null, so can_admin_tenant() is false and a service-role UPDATE that
-- changes anything but reply_seen_at RAISES (the same P0001 shape as the events /
-- songs guards from 0022-0026 — see the memory note about seeding). Nothing writes
-- this table with the service role today (the backup job only SELECTs, and
-- /api/notify only reads the row to find the recipient). If a future job needs to,
-- give it its own SECURITY DEFINER function rather than loosening this.

alter table public.feedback
  add column if not exists reply         text,
  add column if not exists replied_at    timestamptz,
  add column if not exists replied_by    uuid references auth.users(id) on delete set null,
  add column if not exists reply_seen_at timestamptz,
  add column if not exists images        text[] not null default '{}'::text[];

comment on column public.feedback.images is
  'R2 object keys (not URLs) under <tenant>/feedback/<author>/<random>.<ext>';

-- The author may now update their OWN row; the trigger below decides what that
-- actually permits. Admin behaviour is unchanged.
drop policy if exists feedback_update on public.feedback;
create policy feedback_update on public.feedback
  for update using (public.can_admin_tenant(tenant_id) or user_id = auth.uid())
  with check (public.can_admin_tenant(tenant_id) or user_id = auth.uid());

create or replace function public.guard_feedback_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Admins triage: status, reply, delete — everything, as before 0043.
  if public.can_admin_tenant(new.tenant_id) then
    return new;
  end if;

  -- Everyone else reaching this trigger is the row's own author (the policy above
  -- admits nobody else). They may stamp that they have read the reply, and that is
  -- the whole of it — the message they sent, the admin's answer, the triage status
  -- and the attachment list all stay exactly as they are.
  if new.id            is distinct from old.id
     or new.tenant_id  is distinct from old.tenant_id
     or new.user_id    is distinct from old.user_id
     or new.category   is distinct from old.category
     or new.message    is distinct from old.message
     or new.context    is distinct from old.context
     or new.status     is distinct from old.status
     or new.created_at is distinct from old.created_at
     or new.reply      is distinct from old.reply
     or new.replied_at is distinct from old.replied_at
     or new.replied_by is distinct from old.replied_by
     or new.images     is distinct from old.images
  then
    raise exception 'ผู้ส่งฟีดแบคแก้ไขได้เฉพาะสถานะอ่านคำตอบแล้วเท่านั้น';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_feedback_update on public.feedback;
create trigger guard_feedback_update
  before update on public.feedback
  for each row execute function public.guard_feedback_update();

-- The author's own list ("ที่ส่งไปแล้ว") reads by user_id, newest first — the
-- existing index is (tenant_id, created_at desc) and does not serve that.
create index if not exists feedback_user_created_idx
  on public.feedback (user_id, created_at desc);
