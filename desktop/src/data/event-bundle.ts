// Client-side mirror of lib/queries.ts `getEventBundle` for the desktop SPA.
// Loads one event with all of its child data through the browser Supabase client.
import { createClient } from "@/lib/supabase/client";
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

  const { data: event } = await supabase
    .from("events")
    .select("*, groups(*)")
    .eq("id", eventId)
    .maybeSingle();

  if (!event) return null;

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

  return {
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
}
