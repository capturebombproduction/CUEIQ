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
import { hasLiveSession } from "@/lib/auth-session";
import { pendingMgmtOps } from "~/data/mgmt-outbox";
import type { WorkspaceData } from "~/data/workspace";

export type EventWithGroup = EventRow & {
  groups: { name: string; color: string | null; exempt_from_deadline: boolean } | null;
};

/** How long the dashboard list may wait on Supabase before serving the cache.
 *
 *  isOffline() only catches the network the OS knows is gone. The venue case that
 *  actually happens is the other one: wifi JOINED, navigator.onLine TRUE, TCP
 *  connects and nothing ever answers. The await below had no bound of its own, so
 *  the dashboard sat on "กำลังโหลดงาน…" for ever with this exact list already in
 *  localStorage — the same hang ~/data/workspace.ts fixes one layer up, and it is
 *  worth fixing in both places because either one alone still parks the screen.
 *
 *  Matches WORKSPACE_READ_TIMEOUT_MS: a working-but-slow hotspot should still get
 *  to deliver FRESH data rather than be written off as dead. Anything slower falls
 *  through to the cache, which is what the ลองใหม่ button then retries from. */
export const EVENTS_LIST_TIMEOUT_MS = 8000;

/** Resolves to `null` if `p` has not settled within `ms`. The in-flight request is
 *  deliberately NOT cancelled — a late answer can still warm the cache for the next
 *  screen; we simply stop waiting on it. (Mirrors ~/data/workspace.ts.) */
function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T | null>([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    // Without this the pending timer keeps a handle alive for its full duration
    // after every fast, successful load.
    if (timer !== undefined) clearTimeout(timer);
  });
}

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
    // A request that NEVER answers is the same situation as one that fails, so it
    // takes the same branch: withTimeout hands back null and we serve the cache.
    res = await withTimeout(
      supabase
        .from("events")
        .select("*, groups(name, color, exempt_from_deadline)")
        .eq("tenant_id", tenantId)
        .in("group_id", viewableGroupIds)
        .eq("is_template", false)
        .eq("is_practice", false)
        .order("event_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }),
      EVENTS_LIST_TIMEOUT_MS
    );
  } catch {
    return withPendingOverlay(readCache<EventWithGroup[]>(cacheKey) ?? []);
  }

  if (!res || res.error) return withPendingOverlay(readCache<EventWithGroup[]>(cacheKey) ?? []);

  const events = (res.data ?? []) as EventWithGroup[];
  // An EMPTY result is the one answer we can't take at face value: a request that
  // went out as anon (see hasLiveSession — a refresh that failed in the last
  // minute) is refused by RLS as an empty list with NO error, and it looks exactly
  // like "this user has no events". Writing that through would replace this
  // device's cached dashboard with nothing — and the next time it opens with no
  // network, the whole dashboard is blank, which is precisely the failure the
  // read-cache exists to prevent. Cheap to prove, so prove it (a real empty list
  // still caches: the check only runs when there is nothing to lose).
  // …and bound this one too. getSession() can itself attempt a token refresh over
  // the same dead network, so an empty answer arriving just before the wifi went
  // black-holed would otherwise park the dashboard here instead of one await up.
  // A timeout is "we could not prove the request carried our token", which is
  // exactly the case this guard already treats as too dangerous to cache.
  if (events.length === 0 && (await withTimeout(hasLiveSession(), EVENTS_LIST_TIMEOUT_MS)) !== true) {
    return withPendingOverlay(readCache<EventWithGroup[]>(cacheKey) ?? []);
  }
  writeCache(cacheKey, events);
  return withPendingOverlay(events);
}
