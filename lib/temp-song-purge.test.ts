import { describe, it, expect, vi } from "vitest";
import {
  EVENT_GRACE_DAYS,
  parseHttpDateMs,
  planTempSongPurge,
  stillTemporary,
  tempSongCandidates,
  type EventDateRow,
  type SetlistLink,
  type TempSong,
} from "./temp-song-purge";

// The two incidents these tests pin, so a future refactor has to argue with them:
//  · a device whose clock ran days fast used to delete every temporary song (and
//    its R2 master) in the opener's scope — an admin's scope is all 8 bands;
//  · a song uploaded ad hoc at a rehearsal for a show five days out was "expired"
//    two days BEFORE the show and got swept by whoever opened คลังเพลง first;
//  · (round 11) the session check that was supposed to stop an ANON-degraded
//    setlist read from reading as "nothing needs this file" ran BEFORE that read
//    instead of after it, so it proved nothing at all.
// All three end in a deleted master with no undo, so every ambiguous case below
// must resolve toward KEEPING the file.

const DAY = 86400000;
const SERVER_NOW = Date.parse("2026-08-07T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const expiredSong: TempSong = {
  id: "s-expired",
  title: "แทร็คสำรอง",
  audio_path: "t/g/songs/expired-1.wav",
  audio_expires_at: iso(SERVER_NOW - 2 * DAY),
};
const freshSong: TempSong = {
  id: "s-fresh",
  title: "เพลงเปิดตัว",
  audio_path: "t/g/songs/fresh-1.wav",
  audio_expires_at: iso(SERVER_NOW + 1 * DAY),
};
const permanentSong: TempSong = {
  id: "s-permanent",
  title: "เพลงในคลัง",
  audio_path: "t/g/songs/perm-1.wav",
  audio_expires_at: null,
};

const base = {
  candidates: [expiredSong, freshSong],
  serverNowMs: SERVER_NOW,
  links: [] as SetlistLink[],
  events: [] as EventDateRow[],
  // The happy path: the reads demonstrably went out as the user.
  proveSession: async () => true,
};

describe("tempSongCandidates", () => {
  it("picks only the songs carrying a temporary stamp", () => {
    expect(
      tempSongCandidates([expiredSong, freshSong, permanentSong]).map((s) => s.id)
    ).toEqual(["s-expired", "s-fresh"]);
  });

  it("does not look at any clock — a not-yet-expired temp song is still a candidate", () => {
    // The point of the split: the SERVER decides expiry, this only decides which
    // ids we are allowed to ask about.
    expect(tempSongCandidates([freshSong]).map((s) => s.id)).toEqual(["s-fresh"]);
  });

  it("skips a temporary row that has no master file at all", () => {
    // Live Mode inserts the song row first and sets audio_path only once the
    // upload lands, so a WAV that died mid-flight at the venue leaves this shape.
    // There are no R2 bytes to reclaim, and the confirm dialog tells the user to
    // press a 🔒 that the no-audio row does not render. Not this sweep's job.
    const noFile: TempSong = {
      id: "s-no-file",
      title: "อัปไม่สำเร็จ",
      audio_path: null,
      audio_expires_at: iso(SERVER_NOW - 9 * DAY),
    };
    expect(tempSongCandidates([noFile, expiredSong]).map((s) => s.id)).toEqual([
      "s-expired",
    ]);
  });
});

describe("planTempSongPurge — the device clock gets no vote", () => {
  it("purges nothing at all when there is no server instant", async () => {
    const plan = await planTempSongPurge({ ...base, serverNowMs: null });
    expect(plan.purge).toEqual([]);
    expect(plan.blocked).toBe("no-server-clock");
  });

  it("ignores a wildly wrong local clock: only the passed-in server time counts", async () => {
    // Simulates the dead-CMOS laptop: everything looks long expired to the device,
    // but the server says only one of them actually is.
    const plan = await planTempSongPurge({ ...base, serverNowMs: SERVER_NOW });
    expect(plan.purge.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("treats an unparseable expiry stamp as NOT expired", async () => {
    const plan = await planTempSongPurge({
      ...base,
      candidates: [{ id: "s-bad", audio_expires_at: "ไม่ใช่วันที่" }],
    });
    expect(plan.purge).toEqual([]);
    expect(plan.blocked).toBeNull();
  });
});

describe("planTempSongPurge — a show that hasn't happened keeps its file", () => {
  const linkTo = (eventId: string): SetlistLink[] => [
    { song_id: "s-expired", event_id: eventId },
  ];

  it("keeps a song a future event still points at", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: linkTo("ev-future"),
      events: [{ id: "ev-future", event_date: "2026-08-12" }],
    });
    expect(plan.purge).toEqual([]);
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("keeps a song for an event happening TODAY (the show-day case)", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: linkTo("ev-today"),
      events: [{ id: "ev-today", event_date: "2026-08-07" }],
    });
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("still keeps it through the grace day after the show", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: linkTo("ev-yesterday"),
      events: [{ id: "ev-yesterday", event_date: "2026-08-06" }],
    });
    expect(EVENT_GRACE_DAYS).toBe(1);
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("finally purges once the show is properly past", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: linkTo("ev-old"),
      events: [{ id: "ev-old", event_date: "2026-07-30" }],
    });
    expect(plan.purge.map((s) => s.id)).toEqual(["s-expired"]);
    expect(plan.keptForEvent).toEqual([]);
  });

  it("keeps it when the linked event has NO date (a draft show is not a finished one)", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: linkTo("ev-undated"),
      events: [{ id: "ev-undated", event_date: null }],
    });
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("keeps it when the linked event row did not come back (RLS hid it)", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: linkTo("ev-invisible"),
      events: [], // read succeeded, but this event isn't in it
    });
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("keeps it when a link carries no event id at all", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: [{ song_id: "s-expired", event_id: null }],
      events: [],
    });
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("protects only the song with the weird link, not every song", async () => {
    const other: TempSong = {
      id: "s-expired-2",
      audio_path: "t/g/songs/expired-2.wav",
      audio_expires_at: iso(SERVER_NOW - 5 * DAY),
    };
    const plan = await planTempSongPurge({
      ...base,
      candidates: [expiredSong, other],
      links: [{ song_id: "s-expired", event_id: null }],
      events: [],
    });
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
    expect(plan.purge.map((s) => s.id)).toEqual(["s-expired-2"]);
  });

  it("keeps a song linked to BOTH a finished and an upcoming show", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: [
        { song_id: "s-expired", event_id: "ev-old" },
        { song_id: "s-expired", event_id: "ev-future" },
      ],
      events: [
        { id: "ev-old", event_date: "2026-07-01" },
        { id: "ev-future", event_date: "2026-09-01" },
      ],
    });
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("ignores links belonging to some OTHER song", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: [{ song_id: "someone-else", event_id: "ev-future" }],
      events: [{ id: "ev-future", event_date: "2026-09-01" }],
    });
    expect(plan.purge.map((s) => s.id)).toEqual(["s-expired"]);
  });
});

describe("planTempSongPurge — a read that failed is not a read that found nothing", () => {
  it("purges nothing when the setlist read did not come back", async () => {
    const plan = await planTempSongPurge({ ...base, links: null });
    expect(plan.purge).toEqual([]);
    expect(plan.blocked).toBe("links-unverified");
  });

  it("purges nothing when the event read did not come back", async () => {
    const plan = await planTempSongPurge({
      ...base,
      links: [{ song_id: "s-expired", event_id: "ev-x" }],
      events: null,
    });
    expect(plan.purge).toEqual([]);
    expect(plan.blocked).toBe("events-unverified");
  });

  it("does not demand an event read when nothing is linked", async () => {
    const plan = await planTempSongPurge({ ...base, links: [], events: null });
    expect(plan.blocked).toBeNull();
    expect(plan.purge.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("short-circuits before any read matters when nothing is expired", async () => {
    const plan = await planTempSongPurge({
      ...base,
      candidates: [freshSong],
      links: null,
      events: null,
    });
    expect(plan.blocked).toBeNull();
    expect(plan.purge).toEqual([]);
  });
});

// Round 11's incident, and the reason planTempSongPurge is async at all.
//
// Round 10 asked hasLiveSession() in the CALLER, before it issued the setlist
// read. That proves the session was live BEFORE the request — not that the
// request went out as the user. supabase-js substitutes the anon key the moment
// getSession() resolves null, RLS answers with `[]` and `error:null`, and this
// function's contract says `[]` means "proved unused". A laptop waking up at the
// venue could pass the check at t=0, lose its token at t=3s, and hand the sweep
// an empty array that condemned next Saturday's backing track.
//
// These tests pin the ordering, not the wording: the question is asked THROUGH
// this function, which only ever sees the reads as finished data, so it cannot
// be asked too early again.
describe("planTempSongPurge — an empty read only counts if it was really us", () => {
  it("purges nothing when the session cannot be proven live", async () => {
    // Exactly the anon-degraded shape: an expired song, no links came back.
    const plan = await planTempSongPurge({
      ...base,
      proveSession: async () => false,
    });
    expect(plan.purge).toEqual([]);
    expect(plan.blocked).toBe("session-unverified");
  });

  it("purges nothing when the session probe throws", async () => {
    const plan = await planTempSongPurge({
      ...base,
      proveSession: async () => {
        throw new Error("network");
      },
    });
    expect(plan.purge).toEqual([]);
    expect(plan.blocked).toBe("session-unverified");
  });

  it("asks exactly once, and only when a file is actually about to go", async () => {
    // The ordering guarantee lives in the signature: this function receives the
    // reads as finished data, so anything it calls provably runs after them. What
    // this pins is that the call is on the authorising path and nowhere else — if
    // someone moves the check back into the caller, `proveSession` stops being
    // called at all and this is the test that has to be argued with.
    const proveSession = vi.fn(async () => true);
    const plan = await planTempSongPurge({ ...base, proveSession });
    expect(proveSession).toHaveBeenCalledTimes(1);
    expect(plan.purge.map((s) => s.id)).toEqual(["s-expired"]);
  });

  it("does not spend a round-trip when nothing would be purged anyway", async () => {
    // Cheap-path guarantee: opening คลังเพลง on a library with nothing expired
    // must not cost an extra auth call. Also covers the blocked paths — there is
    // nothing to authorise, so there is nothing to ask about.
    const proveSession = vi.fn(async () => true);
    await planTempSongPurge({ ...base, candidates: [freshSong], proveSession });
    await planTempSongPurge({ ...base, links: null, proveSession });
    await planTempSongPurge({ ...base, serverNowMs: null, proveSession });
    await planTempSongPurge({
      ...base,
      links: [{ song_id: "s-expired", event_id: "ev-future" }],
      events: [{ id: "ev-future", event_date: "2026-09-01" }],
      proveSession,
    });
    expect(proveSession).not.toHaveBeenCalled();
  });

  it("a live session does not resurrect a song an unfinished show still wants", async () => {
    // The proof is a veto, never a licence: it can only ever subtract from the
    // purge set the earlier guards allowed.
    const plan = await planTempSongPurge({
      ...base,
      links: [{ song_id: "s-expired", event_id: "ev-future" }],
      events: [{ id: "ev-future", event_date: "2026-09-01" }],
      proveSession: async () => true,
    });
    expect(plan.purge).toEqual([]);
    expect(plan.keptForEvent.map((s) => s.id)).toEqual(["s-expired"]);
  });
});

describe("parseHttpDateMs", () => {
  it("reads a real Supabase Date header", () => {
    expect(parseHttpDateMs("Fri, 07 Aug 2026 19:02:31 GMT")).toBe(
      Date.parse("2026-08-07T19:02:31Z")
    );
  });

  it("returns null for a missing or unparseable header — no clock, no delete", () => {
    expect(parseHttpDateMs(null)).toBeNull();
    expect(parseHttpDateMs(undefined)).toBeNull();
    expect(parseHttpDateMs("")).toBeNull();
    expect(parseHttpDateMs("soon")).toBeNull();
  });
});

describe("stillTemporary", () => {
  // Round 12: the sweep no longer opens a dialog by itself, so the plan can sit in
  // a bar for an hour before anyone presses it. In that hour the user can press 🔒
  // on one of these rows — the one action that saves a file — and the dialog must
  // stop naming it. Every case here resolves toward NOT deleting.
  const offered: TempSong[] = [
    { id: "a", title: "A", audio_path: "p/a.wav", audio_expires_at: iso(SERVER_NOW - DAY) },
    { id: "b", title: "B", audio_path: "p/b.wav", audio_expires_at: iso(SERVER_NOW - DAY) },
  ];

  it("drops a song that has since been promoted to permanent", () => {
    const current: TempSong[] = [
      { id: "a", audio_expires_at: null }, // 🔒 pressed while the bar waited
      { id: "b", audio_expires_at: iso(SERVER_NOW - DAY) },
    ];
    expect(stillTemporary(offered, current).map((s) => s.id)).toEqual(["b"]);
  });

  it("drops a song that is no longer in the table at all", () => {
    // Deleted from its own row while the offer waited. Absence means drop: an
    // offer may only ever shrink.
    expect(stillTemporary(offered, [offered[1]]).map((s) => s.id)).toEqual(["b"]);
  });

  it("keeps the offer intact when nothing changed, and returns the OFFERED objects", () => {
    // The caller deletes R2 masters off these objects' audio_path, so it must get
    // back the rows it planned with, not the narrowed shapes it compared against.
    const kept = stillTemporary(offered, [
      { id: "a", audio_expires_at: iso(SERVER_NOW - DAY) },
      { id: "b", audio_expires_at: iso(SERVER_NOW - DAY) },
    ]);
    expect(kept).toEqual(offered);
    expect(kept[0].audio_path).toBe("p/a.wav");
  });

  it("returns nothing when the table is empty — an empty read must never widen a delete", () => {
    expect(stillTemporary(offered, [])).toEqual([]);
  });
});
