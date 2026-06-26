// Client-side mirror of lib/queries.ts `getEventBundle` for the desktop SPA.
// Loads one event with all of its child data through the browser Supabase client.
import { createClient } from "@/lib/supabase/client";
import { isOffline, readCache, writeCache } from "~/data/cache";
import type {
  EventRow,
  Group,
  MicAssignment,
  Member,
  Role,
  ScheduleItem,
  SetlistItem,
  Song,
} from "@/lib/types";

export interface EventBundle {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  songs: Song[];
  lineup: string[]; // member_ids performing at this event (empty = not chosen yet)
  role: Role | null;
}

export async function loadEventBundle(eventId: string): Promise<EventBundle | null> {
  const supabase = createClient();
  const cacheKey = `event:${eventId}`;

  // Offline: the network reads below would all fail, so serve the last good
  // bundle for this event from cache (null if it was never opened online).
  if (isOffline()) return readCache<EventBundle>(cacheKey);

  let eventRes;
  try {
    eventRes = await supabase
      .from("events")
      .select("*, groups(*)")
      .eq("id", eventId)
      .maybeSingle();
  } catch {
    // Network failure mid-read → fall back to the cached bundle.
    return readCache<EventBundle>(cacheKey);
  }

  const event = eventRes.data;
  if (!event) {
    // Tell a real "deleted" (read succeeded, row gone) apart from an error: only
    // resurface the cache on an actual error, never for a genuine deletion.
    return eventRes.error ? readCache<EventBundle>(cacheKey) : null;
  }

  const { data: membership } = await supabase
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", event.tenant_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const [schedule, setlist, micMap, members, songs, lineup] = await Promise.all([
    supabase
      .from("schedule_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("setlist_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("mic_assignments")
      .select("*")
      .eq("event_id", eventId)
      .order("mic_number", { ascending: true })
      .order("order_index", { ascending: true }),
    supabase
      .from("members")
      .select("*")
      .eq("group_id", event.group_id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("songs")
      .select("*")
      .eq("group_id", event.group_id)
      .order("title", { ascending: true }),
    supabase
      .from("event_members")
      .select("member_id")
      .eq("event_id", eventId),
  ]);

  const bundle: EventBundle = {
    event: {
      ...(event as unknown as EventRow),
      group: (event.groups as unknown as Group) ?? null,
    },
    schedule: (schedule.data ?? []) as ScheduleItem[],
    setlist: (setlist.data ?? []) as SetlistItem[],
    micMap: (micMap.data ?? []) as MicAssignment[],
    members: (members.data ?? []) as Member[],
    songs: (songs.data ?? []) as Song[],
    lineup: ((lineup.data ?? []) as { member_id: string }[]).map((r) => r.member_id),
    role: (membership?.role as Role) ?? null,
  };
  writeCache(cacheKey, bundle);
  return bundle;
}
