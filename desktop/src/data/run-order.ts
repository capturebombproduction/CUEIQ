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
  const { data, error } = await createClient()
    .from("events")
    .select("id, name, event_date")
    .eq("id", eventId)
    .maybeSingle();
  if (error) return { ok: false, gone: false };
  if (!data) {
    // No row has two very different meanings: actually deleted, or RLS answering
    // an anon request (a token refresh that failed a minute ago) with nothing.
    return { ok: false, gone: await hasLiveSession() };
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
  return !(await hasLiveSession());
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
    const { data, error } = await fetchSequence(tenantId, ev.name, ev.date);
    if (error) return served(cached());
    const seqs = (data ?? []) as RunSeqLive[];
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
    const festRes = await fq;
    if (festRes.error) return served(cached());
    const festEvents = festRes.data ?? [];
    const ids = festEvents.map((e) => e.id as string);

    // Ordered by start_time so a band's slots arrive in the order it actually
    // plays — the builder seeds the running order straight off this list.
    const stageRes = ids.length
      ? await sb
          .from("schedule_items")
          .select("event_id, start_time, end_time")
          .eq("tenant_id", tenantId)
          .eq("kind", "stage")
          .in("event_id", ids)
          .order("start_time", { ascending: true })
      : { data: [], error: null };
    if (stageRes.error) return served(cached());

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

    const seqRes = await fetchSequence(tenantId, ev.name, ev.date);
    if (seqRes.error) return served(cached());
    const seqs = (seqRes.data ?? []) as RunSequence[];
    if (await emptyIsSuspect(seqs, cached())) return served(cached());

    const out: RunOrderBuild = { name: ev.name, date: ev.date, seqs, bandEvents };
    writeCache(buildKey(eventId), out);
    return { status: "ok", data: out, fromCache: false };
  } catch {
    return served(cached());
  }
}
