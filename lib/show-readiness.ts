// Preflight "Show Readiness Check" — gathers the on-device signals that decide
// whether THIS device can safely run a show, ESPECIALLY offline (worst case: no
// net the whole gig). Are all of the setlist's audio files cached at the current
// version? Is storage pinned so the browser won't evict them before the show? Is
// there free space, charge, and a network link? Pure data-gathering (browser APIs
// only) so the UI component (show-readiness-check.tsx) just renders the result.
//
// It also answers the question the download counts CANNOT answer: is every song
// row in this set accounted for by something? A row whose song was deleted keeps
// existing with `song_id` NULL and is silently skipped by both resolvers, so a
// count of "3/3 downloaded" can be true of a 4-row set (see unaccountedSetlistRows).
//
// Builds on the existing readiness primitive (lib/audio-prefetch.ts getReadiness)
// and the same persist() / estimate() the dashboard already uses — this just
// pulls them together into one preflight, the foundation of offline-first (audio
// must be present before anything else matters; see docs/offline-first-plan.md §11-B).

import { getReadiness, type PrefetchTarget, type Readiness } from "./audio-prefetch";

export interface StorageInfo {
  persisted: boolean | null; // null = unknown/unsupported; true = browser won't evict
  usage: number | null; // bytes used by this origin (all stores)
  quota: number | null; // bytes available to this origin
  free: number | null; // quota - usage, clamped ≥ 0
}

export interface BatteryInfo {
  level: number | null; // 0..1, or null if unknown
  charging: boolean | null;
  supported: boolean; // false on browsers without the Battery API (e.g. iOS Safari)
}

export interface ShowReadiness {
  audio: Readiness;
  storage: StorageInfo;
  battery: BatteryInfo;
  online: boolean;
  /**
   * Setlist rows that resolved to NOTHING — not a download target, not a
   * master-less song this device might hold bytes for. They will be silent on
   * stage. Empty when the caller did not hand over the setlist (see
   * `getShowReadiness`), which is not the same as "there are none".
   */
  silent: SilentRow[];
}

/**
 * A setlist row as this preflight needs to see it (a superset of SetlistItem), so
 * callers can hand over `bundle.setlist` verbatim. `song_id` is accepted but no
 * longer READ here — see SilentRow for why the judgement it used to feed was cut.
 */
export interface ShowSetlistRow {
  id: string;
  kind: string;
  title?: string | null;
  song_id?: string | null;
}

/**
 * A song row that no resolver claimed, named so a human can look at it before the
 * show. Deliberately just an id and a name.
 *
 * There WAS a `reason: "no_song" | "unresolved"` field here, added by round 10 and
 * DELETED in the round-11 wave-2 repair, because "unresolved" was unreachable and
 * nothing ever read either state. On the only production path
 * (desktop/src/pages/live.tsx builds both lists from the same `bundle.setlist` and
 * the same `songAudio`) every row with a non-null `song_id` is ALWAYS accounted:
 * resolveAudioTargets claims it when the song has a path, and
 * resolveLocalOnlyCandidates claims it otherwise — including when the song id is
 * missing from `songAudio` entirely (lib/audio-targets.ts:78). So the only rows
 * that can reach here have `song_id == null`, the field was a constant, and its
 * docstring taught the next maintainer to tell apart two causes the code cannot.
 * The test that "proved" the second state called the helper directly with a shape
 * the caller cannot construct — the same pattern that let round 10's no-op ship.
 *
 * If a real second cause ever appears, add the field back WITH a consumer and with
 * a test that reaches it through resolveAudioTargets/resolveLocalOnlyCandidates.
 */
export interface SilentRow {
  itemId: string;
  /**
   * The row's own title. When the cause is a deleted library song this is the only
   * name left: `setlist_items.song_id` is ON DELETE SET NULL (migration 0012), so
   * the row survives with its title intact and only its link wiped.
   */
  title: string;
}

/**
 * THE GUARD THIS FILE EXISTS FOR (round 10). Reconcile the setlist against what
 * the resolvers actually accounted for, and hand back every song row that fell
 * through. Both resolvers in lib/audio-targets.ts drop rows by `continue`:
 * `resolveAudioTargets` skips anything with no path, `resolveLocalOnlyCandidates`
 * skips anything with no `song_id`. A row that lost its song hits BOTH skips, so it
 * left no trace anywhere and the preflight printed a green "พร้อมโชว์ออฟไลน์" over
 * a track that plays nothing. A dropped row is not an absent row.
 *
 * Deliberately written as a RECONCILIATION rather than as another copy of the
 * resolve rules: it stays correct no matter what made the row unresolvable —
 * an expired temp song, a hard delete, a bad import, a race with a sync — because
 * it never asks WHY, only "did anyone claim this row?". Keep it that way; the day
 * someone adds a fourth way for a row to lose its audio, this still catches it.
 *
 * `accountedItemIds` = the itemIds of the prefetch targets PLUS the local-only
 * candidates. Only `kind === "song"` rows are judged: an MC/SE/interlude row with
 * no audio is normal (silence is the point).
 */
export function unaccountedSetlistRows(
  setlist: readonly ShowSetlistRow[],
  accountedItemIds: Iterable<string>
): SilentRow[] {
  const accounted = new Set(accountedItemIds);
  const out: SilentRow[] = [];
  for (const row of setlist) {
    if (row.kind !== "song") continue;
    if (accounted.has(row.id)) continue;
    out.push({ itemId: row.id, title: row.title?.trim() || "เพลงที่ยังไม่มีชื่อ" });
  }
  return out;
}

/** "ชื่อ ก, ชื่อ ข, ชื่อ ค +2" — the same shortening the readiness rows already use. */
export function describeSilentRows(rows: readonly SilentRow[], max = 3): string {
  const shown = rows
    .slice(0, max)
    .map((r) => r.title)
    .join(", ");
  return rows.length > max ? `${shown} +${rows.length - max}` : shown;
}

/** persisted + quota/usage in one read. Best-effort: any unsupported field stays null. */
export async function getStorageInfo(): Promise<StorageInfo> {
  const out: StorageInfo = { persisted: null, usage: null, quota: null, free: null };
  if (typeof navigator === "undefined" || !navigator.storage) return out;
  try {
    if (navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch {
    /* unsupported */
  }
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      out.usage = est.usage ?? null;
      out.quota = est.quota ?? null;
      if (out.usage != null && out.quota != null) {
        out.free = Math.max(0, out.quota - out.usage);
      }
    }
  } catch {
    /* unsupported */
  }
  return out;
}

/**
 * Ask the browser to PIN this origin's storage so it won't evict the cached show
 * audio when space runs low. Returns the resulting persisted state (true/false),
 * or null if unsupported. Already-persisted short-circuits to true.
 */
export async function requestPersist(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

interface BatteryManager {
  level: number;
  charging: boolean;
}

/** Battery level/charging if the browser exposes it (Chromium does; iOS Safari
 *  doesn't → supported:false, treated as "unknown, don't block"). */
export async function getBatteryInfo(): Promise<BatteryInfo> {
  if (typeof navigator === "undefined") {
    return { level: null, charging: null, supported: false };
  }
  const getBattery = (
    navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
  ).getBattery;
  if (typeof getBattery !== "function") {
    return { level: null, charging: null, supported: false };
  }
  try {
    const b = await getBattery.call(navigator);
    return {
      level: typeof b.level === "number" ? b.level : null,
      charging: !!b.charging,
      supported: true,
    };
  } catch {
    return { level: null, charging: null, supported: false };
  }
}

/**
 * All preflight signals for one event's audio targets, gathered in parallel.
 *
 * Pass `opts.setlist` (the event's rows) and `opts.alsoAccounted` (the itemIds of
 * the local-only candidates, which are legitimately not download targets) and the
 * result also carries `silent` — the rows that resolve to nothing at all. WITHOUT
 * them this function can only see the rows the resolvers kept, which is precisely
 * how a set with a song-less row reported ready; `silent: []` then means "not
 * checked", never "checked and clean" — so do not use it as a positive signal.
 *
 * THE WIRING, because round 10 shipped this whole guard with nobody passing `opts`
 * and the green lie therefore went out unchanged: the only caller is
 * components/event/show-readiness-check.tsx, which takes a `setlist` prop and is
 * mounted by desktop/src/pages/live.tsx (the Show Runner, the copy that travels to
 * venues). If you add another mount, pass the setlist there too.
 *
 * WHAT THE COMPONENT DOES WITH `silent`, corrected in the wave-2 repair: it QUALIFIES
 * THE HEADLINE and nothing else — the one-line verdict reads "พร้อมโชว์ — แต่มี N
 * แถวที่ไม่มีไฟล์เสียง" instead of a bare "พร้อมโชว์ออฟไลน์", and the expanded body
 * lists the rows in a MUTED tone. It is not a warning, not a fault, and does not
 * auto-open the panel. It said all three of those for one round, and on a live_band
 * event whose five songs were typed in by hand — a first-class, supported way to
 * build a setlist — that printed five red "จะเงียบ" rows over a healthy show with no
 * action anywhere in the app that could clear them. The device genuinely cannot tell
 * a hand-typed row from a row whose song was deleted (lib/completeness.ts makes the
 * same argument about the same data), so anything stronger than stating the fact is
 * a guess against the user.
 */
export async function getShowReadiness(
  eventId: string,
  targets: PrefetchTarget[],
  opts?: { setlist?: readonly ShowSetlistRow[]; alsoAccounted?: Iterable<string> }
): Promise<ShowReadiness> {
  const [audio, storage, battery] = await Promise.all([
    getReadiness(eventId, targets),
    getStorageInfo(),
    getBatteryInfo(),
  ]);
  const silent = opts?.setlist
    ? unaccountedSetlistRows(opts.setlist, [
        ...targets.map((t) => t.itemId),
        ...(opts.alsoAccounted ?? []),
      ])
    : [];
  return {
    audio,
    storage,
    battery,
    online: typeof navigator !== "undefined" ? navigator.onLine !== false : true,
    silent,
  };
}

/** Bytes → compact human label (shared by the readiness UI). */
export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "<0.1 MB";
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
