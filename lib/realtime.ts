// The app's realtime topics, in one place, and the one way to open them.
//
// Every channel CueIQ opens is PRIVATE. A public topic is readable and writable
// by anyone holding the anon key — which ships in the JS bundle — so before this
// an unauthenticated client that knew an event uuid could listen to a running
// show and broadcast `fromController: true` to take it. Private topics are a
// separate namespace on the server (probed both ways: private↔public messages do
// not cross), and joining one is authorized by the RLS policies in
// 0040_realtime_authorization.sql.
//
// ⚠️ The topic STRINGS are parsed by SQL: `can_use_realtime_topic()` reads the
// kind before the first ':' and the uuid between the first and second. Build them
// here — never inline — so the client and the policy can't drift apart.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/** Live Mode's show state, and the setlist builder's on-air lock. */
export const liveTopic = (eventId: string) => `live:${eventId}`;

/** A band's library changed (new master, retitle) — Live Mode re-resolves audio. */
export const songsTopic = (groupId: string) => `songs:${groupId}`;

/** The festival running-order board, shared by every band at one event.
 *  The name is encodeURIComponent'd so it can never contain a ':' and shift the
 *  uuid's position — which is exactly how the SQL side finds the tenant. */
export const runOrderTopic = (
  tenantId: string,
  eventDate: string | null,
  eventName: string
) => `runorder:${tenantId}:${eventDate ?? "x"}:${encodeURIComponent(eventName)}`;

/**
 * Open one of the topics above as a private channel.
 *
 * `broadcast.self: false` matches what every call site already asked for (and
 * realtime's own default): a device never hears its own message back, because
 * every sender applies the change locally first.
 */
export function privateChannel(
  supabase: Pick<SupabaseClient, "channel">,
  topic: string
): RealtimeChannel {
  return supabase.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  });
}
