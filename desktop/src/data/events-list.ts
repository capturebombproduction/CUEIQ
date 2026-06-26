// Cache-aware loader for the dashboard events list (mirrors the inline query that
// used to live in pages/dashboard.tsx). Online: read from Supabase + write-through
// to cache. Offline / network blip: serve the last good list from cache so the
// dashboard isn't blank with no net.
import { createClient } from "@/lib/supabase/client";
import type { EventRow } from "@/lib/types";
import { isOffline, readCache, writeCache } from "~/data/cache";

export type EventWithGroup = EventRow & {
  groups: { name: string; color: string | null; exempt_from_deadline: boolean } | null;
};

export async function loadEventsList(
  tenantId: string,
  viewableGroupIds: string[]
): Promise<EventWithGroup[]> {
  // Key by tenant + scope so a label-wide user and a band-scoped user on the same
  // device don't clobber each other's cached list.
  const cacheKey = `events:${tenantId}:${[...viewableGroupIds].sort().join(",")}`;

  if (isOffline()) return readCache<EventWithGroup[]>(cacheKey) ?? [];

  const supabase = createClient();
  let res;
  try {
    res = await supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("tenant_id", tenantId)
      .in("group_id", viewableGroupIds)
      .eq("is_template", false)
      .eq("is_practice", false)
      .order("event_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
  } catch {
    return readCache<EventWithGroup[]>(cacheKey) ?? [];
  }

  if (res.error) return readCache<EventWithGroup[]>(cacheKey) ?? [];

  const events = (res.data ?? []) as EventWithGroup[];
  writeCache(cacheKey, events);
  return events;
}
