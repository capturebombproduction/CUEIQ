// Who is allowed to order the deletion of a temporary song — and on whose clock.
//
// Background. An ad-hoc upload from Live Mode (components/event/live-mode.tsx)
// creates a TEMPORARY song: `audio_expires_at = now() + 3 days`. Migration 0012
// designed that to self-clean so the library doesn't fill with one-off files, and
// คลังเพลง did the cleaning lazily on open. Two things about that were wrong, and
// both of them end with an R2 master gone for good — there is no undo and no
// second copy:
//
//   (a) THE CLOCK WAS THE DEVICE'S. The sweep compared `audio_expires_at` against
//       `Date.now()` on whatever machine happened to open the page. A show laptop
//       with a dead CMOS battery, a phone someone set forward, a machine restored
//       from an image — any of those decides that EVERY temporary song in the
//       user's scope is expired, and an admin's scope is all 8 bands. A wrong
//       local clock must never be able to authorise an irreversible delete. So the
//       expiry test here takes a server-supplied instant and NOTHING ELSE; when we
//       cannot get one, the answer is "purge nothing", never "guess".
//
//   (b) THE HORIZON WAS MEASURED FROM THE UPLOAD, NOT FROM THE SHOW. Three days
//       from the moment the file was uploaded. A song loaded ad hoc at an Aug-1
//       rehearsal for an Aug-6 show is "expired" on Aug 4, and the first person to
//       merely OPEN คลังเพลง on the 4th destroyed it; `setlist_items.song_id` went
//       NULL (0012 on-delete-set-null), and — because lib/audio-targets.ts skips
//       rows with no song_id — that row then vanished from the completeness gate
//       AND from the desktop readiness preflight too. The show could still read
//       "พร้อมโชว์ออฟไลน์" with a silent track in the set. พี่พัชร์'s ruling:
//       a temporary song must survive until the event that needs it.
//
// (b) is fixed here as a GUARD on the delete path, deliberately NOT as a new
// lifecycle: we do not rewrite `audio_expires_at` when a song is linked to a
// setlist, we do not add a background job, we do not add a column. We simply
// refuse to purge a song that any event which has not happened yet still points
// at. The 3-day stamp keeps meaning exactly what it meant; it just stops being
// the last word.
//
// Everything below is decided from data passed in, so it can be tested
// (lib/temp-song-purge.test.ts). Two functions touch the outside world and both
// are deliberate: fetchServerNowMs is the narrow I/O this file exists to keep
// honest, and planTempSongPurge is async solely so it can ask "was that read
// really us?" at the one moment the question means anything — read its comment
// before making it synchronous again.

/**
 * How many days AFTER an event's date a linked temporary song is still protected.
 *
 * One day, for a boring reason worth writing down: `events.event_date` is a plain
 * `date` holding the Thai calendar date, while the server clock we compare it to
 * is UTC. Bangkok is UTC+7, so the server's "today" is never AHEAD of Bangkok's —
 * the skew already errs toward keeping files. The extra day covers the reverse
 * case if this ever runs somewhere west of UTC, plus the ordinary human one: the
 * gear comes home the morning after the show and nobody wants the file to have
 * evaporated overnight while the recording is still being pulled off the desk.
 */
export const EVENT_GRACE_DAYS = 1;

/** The fields of a library song this decision actually reads. */
export interface TempSong {
  id: string;
  title?: string;
  audio_path?: string | null;
  /** null = permanent; a timestamp = temporary (ad-hoc upload from Live Mode). */
  audio_expires_at?: string | null;
}

/** A `setlist_items` row, narrowed to the two columns that matter here. */
export interface SetlistLink {
  song_id?: string | null;
  event_id?: string | null;
}

/** An `events` row, narrowed. `event_date` is a `date` string, e.g. "2026-08-06". */
export interface EventDateRow {
  id: string;
  event_date?: string | null;
}

/**
 * Why the sweep declined to delete anything. Every one of these means "do nothing
 * and try again next time the library is opened" — retrying is free, and the bytes
 * are not.
 */
export type PurgeBlock =
  /** No trustworthy server instant. See fetchServerNowMs. */
  | "no-server-clock"
  /** The setlist_items read failed, so we cannot prove a song is unused. */
  | "links-unverified"
  /** The events read failed, so we cannot prove the linked show is past. */
  | "events-unverified"
  /**
   * The reads above may have gone out as ANON, so their answers prove nothing.
   * See `proveSession` below — this is the round-11 block, and the reason this
   * function is async.
   */
  | "session-unverified";

export interface PurgePlan<T extends TempSong> {
  /** Safe to delete: the SERVER says expired, and no unfinished event needs it. */
  purge: T[];
  /** Expired by the clock, but still wanted by an event that hasn't happened. */
  keptForEvent: T[];
  /** Non-null = we could not decide safely; `purge` is empty. */
  blocked: PurgeBlock | null;
}

/**
 * Every song carrying a temporary stamp AND an actual master file.
 *
 * This is deliberately clock-free: it produces the set we then ASK THE SERVER
 * about. Doing the "is it expired" arithmetic here would put the device clock
 * back in charge of which ids get offered up for deletion.
 *
 * The `audio_path` half was added in round 11. This sweep exists to reclaim R2
 * bytes, and a row with no path has none: Live Mode inserts the song row FIRST
 * and sets `audio_path` only after the upload lands, so a WAV that died
 * mid-flight at the venue leaves exactly this shape. Those rows were being
 * named in a dialog that told the user "ลบแล้วไฟล์เสียงจะหายถาวร" about a file
 * that does not exist, and pointed them at a 🔒 button that the no-audio row
 * does not render — an instruction nobody could follow. Not our garbage to
 * collect; leave them alone.
 */
export function tempSongCandidates<T extends TempSong>(songs: readonly T[]): T[] {
  return songs.filter((s) => !!s.audio_expires_at && !!s.audio_path);
}

/**
 * Narrow an offer made a while ago to the songs that are STILL temporary now.
 *
 * Round 12 stopped the sweep from opening its own dialog the moment คลังเพลง
 * loads (see components/song/song-library.tsx for that incident); the plan is now
 * shown as a bar the user may press minutes or hours later. The wait made an old
 * hazard reachable: in between, the user can press 🔒 on one of these very rows —
 * the single action the product offers for saving one of these files — and the
 * dialog would still have named it and told them its bytes were about to go.
 *
 * `current` is what the table holds NOW. A song that is no longer there, or whose
 * `audio_expires_at` has been cleared, drops out of the offer. Absence means DROP,
 * never keep: every uncertainty in this module resolves toward not deleting.
 *
 * This is only about what the dialog SAYS. The database is asked again before
 * anything is deleted, and the DELETE itself carries `.lt("audio_expires_at", …)`,
 * which a promoted row can never satisfy.
 */
export function stillTemporary<T extends TempSong>(
  offered: readonly T[],
  current: readonly TempSong[]
): T[] {
  const temporaryNow = new Set(
    current.filter((s) => !!s.audio_expires_at).map((s) => s.id)
  );
  return offered.filter((s) => temporaryNow.has(s.id));
}

/**
 * Parse an HTTP `Date` response header ("Fri, 07 Aug 2026 19:02:31 GMT") into ms.
 *
 * Split out from the fetch purely so it can be tested. Anything we cannot parse
 * is `null`, and `null` means the sweep stands down — a header we don't
 * understand is not a clock, and half-understanding it is how you delete a
 * master three days early.
 */
export function parseHttpDateMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const ms = Date.parse(header);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Days since the epoch, UTC, for an ISO instant. Comparing whole days (rather
 * than instants) is what lets an event dated "today" stay protected all day.
 */
function utcDayIndex(ms: number): number {
  return Math.floor(ms / 86400000);
}

/** "2026-08-06" → its UTC day index; null for anything that isn't a plain date. */
function eventDayIndex(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? utcDayIndex(ms) : null;
}

/**
 * Has this event already happened, by the server's calendar and with the grace
 * window applied? Only a confident YES here lets a linked file be deleted.
 *
 * An event with NO date is treated as not-yet-happened on purpose: a draft show
 * whose date isn't pinned down is the single most likely thing to be sitting on
 * an ad-hoc file, and "we don't know when it is" must never read as "it's over".
 */
function eventIsPast(ev: EventDateRow | undefined, serverNowMs: number): boolean {
  if (!ev) return false; // row we couldn't read (RLS, or it moved) → assume it needs the file
  const day = eventDayIndex(ev.event_date);
  if (day === null) return false; // undated or unparseable → assume it needs the file
  return day < utcDayIndex(serverNowMs) - EVENT_GRACE_DAYS;
}

/**
 * The whole decision, in one place: which temporary songs may actually be purged.
 *
 * Read the guards in order, because the ORDER is the safety property:
 *   1. no server instant            → delete nothing (the device clock gets no vote)
 *   2. server says nothing expired  → delete nothing
 *   3. the link read failed         → delete nothing (can't prove it's unused)
 *   4. the event read failed        → delete nothing (can't prove the show is over)
 *   5. any unfinished event wants it→ keep that song, purge the rest
 *   6. session not provably live    → delete nothing (asked LAST, deliberately)
 *
 * `links` / `events` are `null` to mean "this read did not come back cleanly" —
 * NOT "the table is empty". Passing `[]` for a read that errored is the mistake
 * lib/auth-session.ts was written about, and here it costs an R2 master.
 *
 * WHY THIS FUNCTION IS ASYNC, which otherwise looks like a mistake in a module
 * whose header advertises purity. Round 10 put the session check in the CALLER,
 * before it issued the setlist read. That proves the session was live BEFORE the
 * request — not that the request went out as the user. supabase-js swaps in the
 * anon key the moment getSession() resolves null and auth-js caches a failed
 * refresh for about a minute, so a laptop waking up at the venue can pass the
 * check at t=0, lose its token at t=3s, and have RLS answer the setlist read
 * with `[]` and `error:null`. That empty array means "proved unused" by this
 * function's contract, and the file goes. Same class as write-guard's
 * noRowsMessage(): you ask about the session AFTER the suspicious answer, never
 * before it.
 *
 * A boolean parameter would have fixed it today and rotted tomorrow — nothing
 * stops the next editor computing it too early, which is precisely the bug. So
 * the caller hands over the QUESTION instead of the answer. This function only
 * ever receives the reads as finished data, so any call it makes is provably
 * after them; the ordering is no longer something anybody can get wrong. It is
 * called only when a purge is actually about to be authorised, so the common
 * "nothing expired" open still costs zero extra round-trips.
 */
export async function planTempSongPurge<T extends TempSong>(input: {
  candidates: readonly T[];
  /** From the SERVER (fetchServerNowMs). `null` when we couldn't get one. */
  serverNowMs: number | null;
  /** setlist_items rows for the candidate songs, or null if that read failed. */
  links: readonly SetlistLink[] | null;
  /** events rows for the linked event ids, or null if that read failed. */
  events: readonly EventDateRow[] | null;
  /**
   * "Did the reads above really go out as THIS user?" — normally
   * `hasLiveSession` from lib/auth-session. Anything false-y stands the sweep
   * down. Do NOT turn this back into a boolean; see the note above.
   */
  proveSession: () => Promise<boolean>;
}): Promise<PurgePlan<T>> {
  const { candidates, serverNowMs, links, events, proveSession } = input;
  const empty = { purge: [] as T[], keptForEvent: [] as T[] };

  if (serverNowMs === null) return { ...empty, blocked: "no-server-clock" };

  // Expiry is decided ONLY against the server instant. An unparseable stamp is
  // not expired — a bad string must not read as "long overdue".
  const expired = candidates.filter((s) => {
    const at = s.audio_expires_at ? Date.parse(s.audio_expires_at) : NaN;
    return Number.isFinite(at) && at < serverNowMs;
  });
  if (expired.length === 0) return { ...empty, blocked: null };

  if (links === null) return { ...empty, blocked: "links-unverified" };

  const expiredIds = new Set(expired.map((s) => s.id));
  const linkedEvents = new Map<string, Set<string>>(); // songId → eventIds
  const unresolvable = new Set<string>(); // songIds with a link we can't place
  for (const l of links) {
    if (!l.song_id || !expiredIds.has(l.song_id)) continue;
    if (!l.event_id) {
      // A setlist row pointing at this song but at no event shouldn't exist
      // (event_id is NOT NULL) — if we ever see one, keep THAT song's file.
      // Scoped per song on purpose: one weird row must not freeze the sweep for
      // every other song, and must not be silently ignored for its own either.
      unresolvable.add(l.song_id);
      continue;
    }
    const set = linkedEvents.get(l.song_id) ?? new Set<string>();
    set.add(l.event_id);
    linkedEvents.set(l.song_id, set);
  }

  const needsEventDates = linkedEvents.size > 0;
  if (needsEventDates && events === null)
    return { ...empty, blocked: "events-unverified" };

  const eventById = new Map<string, EventDateRow>(
    (events ?? []).map((e) => [e.id, e])
  );

  const purge: T[] = [];
  const keptForEvent: T[] = [];
  for (const song of expired) {
    const ids = linkedEvents.get(song.id);
    const stillWanted =
      unresolvable.has(song.id) ||
      (!!ids &&
        [...ids].some((id) => !eventIsPast(eventById.get(id), serverNowMs)));
    if (stillWanted) keptForEvent.push(song);
    else purge.push(song);
  }

  // Guard 6, last on purpose. Everything above is arithmetic on answers we were
  // given; this is the only step that asks whether those answers were worth
  // anything. If the session cannot be proven live NOW — after every read has
  // already come back — then an empty `links` array may simply be RLS being
  // polite to the anon key, and "nothing needs this file" is not a fact.
  // A throw is a no, not a yes.
  if (purge.length > 0) {
    let live = false;
    try {
      live = await proveSession();
    } catch {
      live = false;
    }
    if (!live) return { ...empty, blocked: "session-unverified" };
  }
  return { purge, keptForEvent, blocked: null };
}

/**
 * The server's clock, read out of the `Date` header of a Supabase REST response.
 *
 * Why this and not `Date.now()`: see the top of this file. Why this and not an
 * RPC: `now()` lives in pg_catalog and is not callable through PostgREST, and
 * adding a function is a migration — a separate, reviewed act. This costs one
 * HEAD request with no body.
 *
 * Two details that look wrong and are not, so nobody "fixes" them:
 *  · It hits a TABLE endpoint (`/rest/v1/songs`), not `/rest/v1/`. Only the
 *    PostgREST-handled paths attach `Access-Control-Expose-Headers: …, Date, …`;
 *    the gateway root does not, and without that header a browser hands back
 *    `null` for `Date` on a cross-origin read. Verified against our own project
 *    from both a normal origin and `Origin: null` (Electron's file://).
 *  · It sends only the anon apikey, so the response is a 401. That is fine and
 *    expected — we want the header, not the body, and the header is present on
 *    the 401. Do not "fix" the 401 by attaching the user's token.
 *
 * Anything at all going wrong returns null, and null means the sweep does
 * nothing. That is the intended failure mode: temporary songs linger a while
 * longer, which costs a few megabytes; the alternative costs a show.
 */
export async function fetchServerNowMs(): Promise<number | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/songs?select=id&limit=1`, {
      method: "HEAD",
      headers: { apikey: key },
      cache: "no-store",
      // A venue Wi-Fi that accepts the connection and then stalls must not leave
      // the library waiting forever on a garbage-collection question nobody asked.
      signal: AbortSignal.timeout(8000),
    });
    return parseHttpDateMs(res.headers.get("date"));
  } catch {
    return null; // offline, blocked, timed out → no clock → no delete
  }
}
