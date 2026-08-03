-- 0040_realtime_authorization.sql
--
-- Lock down the Realtime broadcast topics the app runs a SHOW on.
--
-- THE HOLE (probed against production before writing this, both directions):
--   • an UNAUTHENTICATED client holding only the public anon key — which ships in
--     the JS bundle — could join `live:<eventId>` and receive every state
--     broadcast of a running show, and could SEND one with fromController:true,
--     which the arbitration in live-mode.tsx accepts as a real controller. That
--     is: watch the show, or take it. The only thing standing in the way was
--     knowing an event uuid.
--   • realtime.messages already has RLS ENABLED with ZERO policies, so it looked
--     locked. It is not: Realtime only consults those policies for topics joined
--     with `private: true`, and every channel we opened was public.
--
-- THE FIX is two halves and BOTH are required — this migration is the half that
-- must land FIRST. On its own it changes nothing (no public topic consults these
-- policies), so it is safe to apply ahead of the deploy. The second half is
-- `config.private: true` on every channel in the client.
--
-- Verified with a probe before/after: a private sender's messages do NOT reach a
-- public joiner of the same topic name, and a public sender's messages do NOT
-- reach a private joiner. Private topics are a separate namespace, not just an
-- auth gate — so flipping the client closes the hole rather than papering it.

-- ---------------------------------------------------------------------------
-- Topic → permission. Every topic the app opens is "<kind>:<uuid>[:…]".
-- ---------------------------------------------------------------------------
create or replace function public.can_use_realtime_topic(topic text)
returns boolean
language plpgsql
stable
security invoker           -- must run as the caller: the helpers read auth.uid()
set search_path to 'public'
as $$
declare
  kind text := split_part(topic, ':', 1);
  ref  uuid;
begin
  -- An unparseable or unknown topic is DENIED, so a channel added later has to
  -- come through here on purpose instead of silently inheriting access.
  begin
    ref := split_part(topic, ':', 2)::uuid;
  exception when others then
    return false;
  end;

  if kind = 'live' then
    -- live:<eventId> — Live Mode's show state + the setlist builder's on-air
    -- lock. Same predicate as the events SELECT policies, so anyone who can
    -- already open the show can still follow it and nobody else can. Who may
    -- DRIVE it is a separate question, arbitrated between devices in the client.
    return public.can_view_event(ref) or public.can_read_template_event(ref);

  elsif kind = 'songs' then
    -- songs:<groupId> — library changes (a new master, a retitled song).
    return public.can_view_group(ref);

  elsif kind = 'runorder' then
    -- runorder:<tenantId>:<date>:<url-encoded event name> — the festival running
    -- order is label-wide by design (every band watches the same board), so
    -- tenant membership is the right gate. The name is encodeURIComponent'd, so
    -- it can never contain a ':' and shift the uuid's position.
    return public.is_tenant_member(ref);
  end if;

  return false;
end;
$$;

grant execute on function public.can_use_realtime_topic(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The policies Realtime consults for a private topic. SELECT = may receive,
-- INSERT = may send. `authenticated` only: no CueIQ surface broadcasts anonymously
-- (the public share page renders a server-side snapshot and opens no channel).
-- ---------------------------------------------------------------------------
drop policy if exists cueiq_realtime_receive on realtime.messages;
create policy cueiq_realtime_receive on realtime.messages
  for select to authenticated
  using (public.can_use_realtime_topic(realtime.topic()));

drop policy if exists cueiq_realtime_send on realtime.messages;
create policy cueiq_realtime_send on realtime.messages
  for insert to authenticated
  with check (public.can_use_realtime_topic(realtime.topic()));
