// Cache-aware loader for the dashboard events list (mirrors the inline query that
// used to live in pages/dashboard.tsx). Online: read from Supabase + write-through
// to cache. Offline / network blip: serve the last good list from cache so the
// dashboard isn't blank with no net.
//
// Every path then OVERLAYS the pending offline-management ops (⭐#1 step 2) so an
// event created/edited offline is visible immediately — without this an offline
// create "saves but can't be seen", the trap that sank the earlier naive attempt.
import { createClient } from "@/lib/supabase/client";
import { applyPending, materializeEventRow, type MgmtOp } from "@/lib/mgmt-outbox";
import type { EventRow } from "@/lib/types";
import { isOffline, readCache, writeCache } from "~/data/cache";
import { pendingMgmtOps } from "~/data/mgmt-outbox";
import type { WorkspaceData } from "~/data/workspace";

export type EventWithGroup = EventRow & {
  groups: { name: string; color: string | null; exempt_from_deadline: boolean } | null;
};

/** Overlay pending offline writes; synthesized creates get full display fields. */
async function withPendingOverlay(rows: EventWithGroup[]): Promise<EventWithGroup[]> {
  const ops = await pendingMgmtOps();
  if (ops.length === 0) return rows;
  // Materialize creates up front so applyPending inserts COMPLETE rows: DB-default
  // columns + the `groups` display object (from the cached workspace) the shared
  // EventsList component reads. The stored op keeps only real DB columns.
  const ws = readCache<WorkspaceData>("workspace");
  const displayOps = ops.map((op): MgmtOp => {
    if (op.kind !== "event.create") return op;
    const g = ws?.groups.find((x) => x.id === op.values.group_id) ?? null;
    const row: EventWithGroup = {
      ...materializeEventRow(op, new Date().toISOString()),
      groups: g
        ? {
            name: g.name,
            color: g.color ?? null,
            exempt_from_deadline: g.exempt_from_deadline ?? false,
          }
        : null,
    };
    return { ...op, values: row };
  });
  return applyPending(rows, displayOps);
}

export async function loadEventsList(
  tenantId: string,
  viewableGroupIds: string[]
): Promise<EventWithGroup[]> {
  // Key by tenant + scope so a label-wide user and a band-scoped user on the same
  // device don't clobber each other's cached list.
  const cacheKey = `events:${tenantId}:${[...viewableGroupIds].sort().join(",")}`;

  if (isOffline()) return withPendingOverlay(readCache<EventWithGroup[]>(cacheKey) ?? []);

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
    return withPendingOverlay(readCache<EventWithGroup[]>(cacheKey) ?? []);
  }

  if (res.error) return withPendingOverlay(readCache<EventWithGroup[]>(cacheKey) ?? []);

  const events = (res.data ?? []) as EventWithGroup[];
  writeCache(cacheKey, events);
  return withPendingOverlay(events);
}
