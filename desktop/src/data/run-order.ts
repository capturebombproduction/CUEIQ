// Read-cache for the festival RUNNING ORDER, for both desktop staff screens:
// the builder (/events/:id/run-order) and the live show-caller (…/live).
//
// Neither page touched ~/data/cache, so with no network the builder bounced
// silently to /overview and คุมคิว Live said "โหลดคิวงานไม่สำเร็จ" — at a festival,
// which is the one place the running order matters and the one place the wifi is
// worst. Everything else on the desktop (dashboard, event bundles, library) has
// been read-cached since round 3; these two were simply missed.
//
// Same rules as the rest of the suite: online is unchanged and writes through,
// the cache is only ever a FALLBACK, and an empty answer we cannot prove carried
// our token is treated as a failed read, never as "the order is empty" — the
// board is the thing a whole festival reads, so blanking it is the worst outcome.
//
// ⚠️ READS only. Driving the board offline (จบ+ต่อไป, ±min) still needs the
// network: run_sequence is not in the management outbox, and two stage managers
// each advancing an offline copy of one shared festival order is a conflict this
// app has no answer for yet. A read-only board is honest; a divergent one is not.
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import type { RunSeqLive } from "@/components/event/event-live-caller";
import type { RunBandEvent, RunSequence } from "@/components/event/run-order-builder";
import { isOffline, readCache, writeCache } from "~/data/cache";

export type RunOrderLive = { name: string; date: string | null; seqs: RunSeqLive[] };
export type RunOrderBuild = {
  name: string;
  date: string | null;
  seqs: RunSequence[];
  bandEvents: RunBandEvent[];
};

/** "gone" = the event really is deleted (a read that succeeded and found nothing).
 *  "error" = we could not find out, and hold nothing cached to fall back on. Only
 *  "gone" may navigate the user away — bouncing a show-caller off a live board
 *  because the venue wifi dropped reads as "งานนี้ถูกลบ". */
export type RunOrderResult<T> =
  | { status: "ok"; data: T; fromCache: boolean }
  | { status: "gone" }
  | { status: "error" };

const liveKey = (eventId: string) => `runlive:${eventId}`;
const buildKey = (eventId: string) => `runbuild:${eventId}`;

/** How long ONE read here may wait on Supabase before the cached board is served.
 *
 *  The try/catch below already routes a FAILURE to served(cached()). A HANG never
 *  gets there: isOffline() is false on a venue wifi that is JOINED but black-holed
 *  (navigator.onLine TRUE, TCP connects, nothing ever answers), so every await ran
 *  unbounded and คุมคิว Live sat on its spinner with the running order — the one
 *  thing a whole festival reads — already in localStorage. Same shape as the two
 *  loaders round 11 already bounded, same budget (WORKSPACE_READ_TIMEOUT_MS): slow
 *  still gets to deliver FRESH data; never-answering falls through to the cache. */
export const RUN_ORDER_TIMEOUT_MS = 8000;

/** Resolves to `null` if `p` has not settled within `ms`. The in-flight request is
 *  not cancelled, it is ABANDONED: the timer is cleared on both outcomes, nothing
 *  subscribes to `p` after the race settles so a late value is discarded (it does
 *  NOT warm any cache — no path here writes one), and a late rejection is still
 *  observed by the race, so it cannot go unhandled. (Mirrors ~/data/workspace.ts,
 *  which owns the canonical comment; kept local because that copy is not exported.) */
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

function served<T>(cached: T | null): RunOrderResult<T> {
  return cached ? { status: "ok", data: cached, fromCache: true } : { status: "error" };
}

/** The event row that names the festival, or why we couldn't get it. */
async function loadFestivalEvent(
  eventId: string
): Promise<
  | { ok: true; name: string; date: string | null }
  | { ok: false; gone: boolean }
> {
  // A request that never answers is the same situation as one that errored: we
  // could not find out. Both mean "not gone" — only a read that SUCCEEDED and
  // found nothing may bounce a show-caller off a live board.
  const res = await withTimeout(
    createClient()
      .from("events")
      .select("id, name, event_date")
      .eq("id", eventId)
      .maybeSingle(),
    RUN_ORDER_TIMEOUT_MS
  );
  if (!res || res.error) return { ok: false, gone: false };
  const { data } = res;
  if (!data) {
    // No row has two very different meanings: actually deleted, or RLS answering
    // an anon request (a token refresh that failed a minute ago) with nothing.
    // getSession() can attempt a refresh over the same dead network, so bound it:
    // a timeout is "could not prove the session is live", which is not "deleted".
    return { ok: false, gone: (await withTimeout(hasLiveSession(), RUN_ORDER_TIMEOUT_MS)) === true };
  }
  return {
    ok: true,
    name: data.name as string,
    date: (data.event_date as string | null) ?? null,
  };
}

async function fetchSequence(tenantId: string, name: string, date: string | null) {
  let q = createClient()
    .from("run_sequence")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("event_name", name)
    .order("sort_order", { ascending: true });
  q = date ? q.eq("event_date", date) : q.is("event_date", null);
  return q;
}

/**
 * An empty running order is legitimate — staff simply haven't built it yet — so
 * it can't be rejected outright. But an anon RLS refusal reads exactly the same,
 * and replacing a cached board with "ยังไม่มีคิว" in the middle of a festival is
 * the failure worth guarding. Only ask when there is actually something to lose.
 */
async function emptyIsSuspect(rows: unknown[], cached: unknown | null): Promise<boolean> {
  if (rows.length > 0 || !cached) return false;
  // Bounded for the same reason as every other await in this file: a getSession()
  // that never answers must not park the board. Anything but a proven-live session
  // — false OR a timeout — leaves the empty answer suspect, which is the safe side.
  return (await withTimeout(hasLiveSession(), RUN_ORDER_TIMEOUT_MS)) !== true;
}

export async function loadRunOrderLive(
  tenantId: string,
  eventId: string
): Promise<RunOrderResult<RunOrderLive>> {
  const cached = () => readCache<RunOrderLive>(liveKey(eventId));
  if (isOffline()) return served(cached());
  try {
    const ev = await loadFestivalEvent(eventId);
    if (!ev.ok) return ev.gone ? { status: "gone" } : served(cached());
    const seqRes = await withTimeout(
      fetchSequence(tenantId, ev.name, ev.date),
      RUN_ORDER_TIMEOUT_MS
    );
    if (!seqRes || seqRes.error) return served(cached());
    const seqs = (seqRes.data ?? []) as RunSeqLive[];
    if (await emptyIsSuspect(seqs, cached())) return served(cached());
    const out: RunOrderLive = { name: ev.name, date: ev.date, seqs };
    writeCache(liveKey(eventId), out);
    return { status: "ok", data: out, fromCache: false };
  } catch {
    return served(cached());
  }
}

export async function loadRunOrderBuild(
  tenantId: string,
  eventId: string,
  groupName: Map<string, string>
): Promise<RunOrderResult<RunOrderBuild>> {
  const cached = () => readCache<RunOrderBuild>(buildKey(eventId));
  if (isOffline()) return served(cached());
  const sb = createClient();
  try {
    const ev = await loadFestivalEvent(eventId);
    if (!ev.ok) return ev.gone ? { status: "gone" } : served(cached());

    // Every band's event on this festival day — the builder links slots to these.
    let fq = sb
      .from("events")
      .select("id, group_id")
      .eq("tenant_id", tenantId)
      .eq("name", ev.name)
      .eq("is_template", false)
      .eq("is_practice", false);
    fq = ev.date ? fq.eq("event_date", ev.date) : fq.is("event_date", null);
    const festRes = await withTimeout(fq, RUN_ORDER_TIMEOUT_MS);
    if (!festRes || festRes.error) return served(cached());
    const festEvents = festRes.data ?? [];
    const ids = festEvents.map((e) => e.id as string);

    // Ordered by start_time so a band's slots arrive in the order it actually
    // plays — the builder seeds the running order straight off this list.
    const stageRes = ids.length
      ? await withTimeout(
          sb
            .from("schedule_items")
            .select("event_id, start_time, end_time")
            .eq("tenant_id", tenantId)
            .eq("kind", "stage")
            .in("event_id", ids)
            .order("start_time", { ascending: true }),
          RUN_ORDER_TIMEOUT_MS
        )
      : { data: [], error: null };
    if (!stageRes || stageRes.error) return served(cached());

    // A band can hold SEVERAL stage slots on one festival day (mig 0036 caps only
    // 'photo' at one row per event), so key a LIST — a Map of single rows dropped
    // every slot but the last, and the live caller never announced the others.
    const stagesBy = new Map<string, { start_time: string | null; end_time: string | null }[]>();
    for (const s of stageRes.data ?? []) {
      const slot = {
        start_time: (s.start_time as string | null) ?? null,
        end_time: (s.end_time as string | null) ?? null,
      };
      const list = stagesBy.get(s.event_id as string);
      if (list) list.push(slot);
      else stagesBy.set(s.event_id as string, [slot]);
    }
    // One entry PER STAGE SLOT, all carrying the band's event id. An event with no
    // stage row still gets one slot-less entry so the link dropdown can reach it.
    const bandEvents: RunBandEvent[] = festEvents.flatMap((e) => {
      const base = {
        id: e.id as string,
        group_name: groupName.get(e.group_id as string) ?? "—",
      };
      const slots = stagesBy.get(e.id as string);
      return slots?.length
        ? slots.map((s) => ({ ...base, stage_start: s.start_time, stage_end: s.end_time }))
        : [{ ...base, stage_start: null, stage_end: null }];
    });

    const seqRes = await withTimeout(
      fetchSequence(tenantId, ev.name, ev.date),
      RUN_ORDER_TIMEOUT_MS
    );
    if (!seqRes || seqRes.error) return served(cached());
    const seqs = (seqRes.data ?? []) as RunSequence[];
    if (await emptyIsSuspect(seqs, cached())) return served(cached());

    const out: RunOrderBuild = { name: ev.name, date: ev.date, seqs, bandEvents };
    writeCache(buildKey(eventId), out);
    return { status: "ok", data: out, fromCache: false };
  } catch {
    return served(cached());
  }
}
