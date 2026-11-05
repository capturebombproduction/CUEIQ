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

/** How long a one-off send may take before it is given up (it never throws either way). */
const SEND_ON_TOPIC_LIMIT_MS = 10_000;

/**
 * One broadcast on `topic` from code that does not itself listen on it: the show form's
 * "times changed", the practice room's note to Live, the library's "songs changed", the
 * outboxes' "changed". Best-effort: never throws; resolves once the send settled or gave up.
 *
 * ⚠️ realtime-js keeps ONE channel per topic per client and hands the open one to whoever asks
 * (RealtimeClient.channel), and the browser client is a singleton. These senders used to JOIN
 * a channel of their own and remove it a moment later (2026-11-05, hunt 13 build-1). A screen
 * that opened the same topic inside that window (the show page right after the form saved,
 * Live opened while an outbox flushed) was handed the sender's channel: its subscribe() on a
 * channel already joining never ran its callback, and the sender's removal then tore the
 * channel down - Live sat on "กำลังเชื่อม…", deaf to every phone, until a reload. And with the
 * screen first, the sender's subscribe() never called back, so nothing was sent at all and its
 * 10 s timer removed the screen's channel. So:
 *  - a channel already open on the topic is someone else's: send on it, never remove it;
 *  - otherwise send WITHOUT joining (an unjoined channel's send() goes over REST, so there is
 *    no join to wait for), and remove the channel only while it is still ours alone. A screen
 *    handed it meanwhile has bound listeners or started its own join, and since nobody joined
 *    it before, that screen's subscribe() ran the normal way.
 */
export async function sendOnTopic(
  supabase: Pick<SupabaseClient, "channel" | "getChannels" | "removeChannel">,
  topic: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const existing = supabase
      .getChannels()
      .find((c) => c.topic === `realtime:${topic}` || c.topic === topic);
    if (existing) {
      await settleWithin(existing.send({ type: "broadcast", event, payload }));
      return;
    }
    const ch = privateChannel(supabase, topic);
    await settleWithin(ch.send({ type: "broadcast", event, payload }));
    if (!claimedByAnother(ch)) {
      void Promise.resolve(supabase.removeChannel(ch)).catch(() => {});
    }
  } catch {
    /* best-effort: a notice that fails is read again on the listener's next load */
  }
}

/** Resolves when `p` settles or after SEND_ON_TOPIC_LIMIT_MS, whichever is first; never rejects. */
function settleWithin(p: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SEND_ON_TOPIC_LIMIT_MS);
    Promise.resolve(p)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/** A channel sendOnTopic made but never joined, that a screen has since been handed. */
function claimedByAnother(ch: RealtimeChannel): boolean {
  const { state, bindings } = ch as { state?: string; bindings?: Record<string, unknown[]> };
  if (state && state !== "closed") return true; // someone subscribed it
  return !!bindings && Object.values(bindings).some((list) => Array.isArray(list) && list.length > 0);
}
