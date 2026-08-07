import { describe, expect, it } from "vitest";
import {
  formatBytes,
  getShowReadiness,
  unaccountedSetlistRows,
  describeSilentRows,
  type ShowSetlistRow,
} from "./show-readiness";
import { resolveAudioTargets, resolveLocalOnlyCandidates } from "./audio-targets";

// The compact storage label shown in the pre-show readiness check. A wrong label
// misleads the operator about whether there's room for the show's audio, so pin
// the unit boundaries.
describe("formatBytes", () => {
  it("shows a dash for unknown", () => {
    expect(formatBytes(null)).toBe("—");
  });
  it("floors tiny values to <0.1 MB", () => {
    expect(formatBytes(0)).toBe("<0.1 MB");
    expect(formatBytes(50 * 1024)).toBe("<0.1 MB"); // 50 KB
  });
  it("shows one decimal under 10 MB, none from 10 MB up", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(500 * 1024 * 1024)).toBe("500 MB");
  });
  it("switches to GB at 1024 MB", () => {
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

// ---------------------------------------------------------------------------
// The silent-row guard. The bug it exists for: a song row whose song was deleted
// keeps existing with song_id NULL (ON DELETE SET NULL, migration 0012) and is
// skipped by BOTH resolvers in lib/audio-targets.ts, so it contributed to neither
// the download counts nor the "no file yet" list — and the preflight printed a
// green "พร้อมโชว์ออฟไลน์" over a track that plays nothing.
// ---------------------------------------------------------------------------
describe("unaccountedSetlistRows", () => {
  // A four-row set: two normal linked songs, one MC, and one row whose song was
  // deleted out from under it. This is the shape that produced the green lie.
  const orphanedSet: ShowSetlistRow[] = [
    { id: "i1", kind: "song", title: "Cruel Angel", song_id: "s1" },
    { id: "i2", kind: "song", title: "Zankoku", song_id: "s2" },
    { id: "i3", kind: "mc", title: "MC", song_id: null },
    { id: "i4", kind: "song", title: "เพลงที่ถูกลบไป", song_id: null },
  ];

  it("names the row whose song is gone, and only that row", () => {
    const silent = unaccountedSetlistRows(orphanedSet, ["i1", "i2"]);
    expect(silent).toEqual([{ itemId: "i4", title: "เพลงที่ถูกลบไป" }]);
  });

  it("catches the row END TO END through the real resolvers", () => {
    // Exactly what the event page does today: resolve targets + local-only
    // candidates from the same rows, then reconcile. Before the guard, the union
    // of the two lists silently lost i4.
    const songAudio = {
      s1: { path: "t/g/songs/s1.mp3", name: "s1.mp3" },
      s2: { path: "t/g/songs/s2.mp3", name: "s2.mp3" },
    };
    const targets = resolveAudioTargets(orphanedSet, songAudio);
    const localOnly = resolveLocalOnlyCandidates(orphanedSet, songAudio);
    expect(targets.map((t) => t.itemId)).toEqual(["i1", "i2"]); // i4 vanished here…
    expect(localOnly).toEqual([]); // …and here too
    const silent = unaccountedSetlistRows(orphanedSet, [
      ...targets.map((t) => t.itemId),
      ...localOnly.map((c) => c.itemId),
    ]);
    expect(silent).toHaveLength(1);
    expect(silent[0].itemId).toBe("i4");
  });

  it("a master-less song held on this device is NOT silent (it is a local-only candidate)", () => {
    const rows: ShowSetlistRow[] = [
      { id: "i1", kind: "song", title: "รออัปโหลด", song_id: "s9" },
    ];
    const localOnly = resolveLocalOnlyCandidates(rows, { s9: { path: null, name: null } });
    expect(localOnly.map((c) => c.itemId)).toEqual(["i1"]);
    expect(unaccountedSetlistRows(rows, localOnly.map((c) => c.itemId))).toEqual([]);
  });

  it("never flags non-song rows — an MC with no audio is the normal case", () => {
    const rows: ShowSetlistRow[] = [
      { id: "m1", kind: "mc", title: "MC" },
      { id: "m2", kind: "se", title: "SE" },
      { id: "m3", kind: "interlude", title: "" },
    ];
    expect(unaccountedSetlistRows(rows, [])).toEqual([]);
  });

  // The deleted test that used to live here asserted `reason === "unresolved"` for a
  // row that still names a song. It reached that state by calling the helper directly
  // with an empty accounted list — a shape the caller CANNOT construct: the real path
  // (desktop/src/pages/live.tsx) builds both lists from the same setlist and the same
  // songAudio, so a row with a song_id is always claimed by one resolver or the other.
  // The field was a constant, nothing read it, and the test certified a branch that
  // never ran. This test replaces it by proving the caller's invariant instead.
  it("a row that still names a song is ALWAYS claimed by one of the two resolvers", () => {
    const rows: ShowSetlistRow[] = [
      { id: "i7", kind: "song", title: "มีมาสเตอร์", song_id: "sX" },
      { id: "i8", kind: "song", title: "ยังไม่มีมาสเตอร์", song_id: "sY" },
      // The nastiest shape: a song id that is not in songAudio AT ALL (a stale
      // bundle, a partial read). resolveLocalOnlyCandidates still claims it.
      { id: "i9", kind: "song", title: "ไม่รู้จักเลย", song_id: "sZ" },
    ];
    const songAudio = {
      sX: { path: "t/g/songs/sX.mp3", name: "sX.mp3" },
      sY: { path: null, name: null },
    };
    const targets = resolveAudioTargets(rows, songAudio);
    const localOnly = resolveLocalOnlyCandidates(rows, songAudio);
    expect(
      unaccountedSetlistRows(rows, [
        ...targets.map((t) => t.itemId),
        ...localOnly.map((c) => c.itemId),
      ])
    ).toEqual([]);
  });

  it("gives a nameless row a name so the panel can point at something", () => {
    const rows: ShowSetlistRow[] = [{ id: "i8", kind: "song", title: "   ", song_id: null }];
    expect(unaccountedSetlistRows(rows, [])[0].title).toBe("เพลงที่ยังไม่มีชื่อ");
  });

  it("an empty setlist has nothing silent (and no accounted ids is not an error)", () => {
    expect(unaccountedSetlistRows([], [])).toEqual([]);
  });

  // THE WAVE-2 REGRESSION, pinned at the only layer that can be tested here.
  // A song row added with "+ เพลง" and named by hand has song_id null and no
  // audio_path (components/event/setlist-builder.tsx inserts `{kind:"song",title:""}`
  // and the user types the name). That is a first-class, supported way to build a
  // setlist — a live_band event's whole set can look like this — and it is
  // BYTE-IDENTICAL to a row whose library song was deleted (ON DELETE SET NULL,
  // migration 0012). So this list legitimately contains healthy rows, and the caller
  // must not score it as a fault: components/event/show-readiness-check.tsx renders
  // it muted, keeps it out of `hasWarn`, and does not auto-open the panel for it.
  // It reported five red "จะเงียบ" faults on exactly this data for one round.
  it("a hand-typed live song lands in `silent` — which is why `silent` is not a fault", () => {
    const handTyped: ShowSetlistRow[] = [
      { id: "h1", kind: "song", title: "เพลงที่เล่นสด 1", song_id: null },
      { id: "h2", kind: "song", title: "เพลงที่เล่นสด 2", song_id: null },
    ];
    const targets = resolveAudioTargets(handTyped, {});
    const localOnly = resolveLocalOnlyCandidates(handTyped, {});
    expect(targets).toEqual([]);
    expect(localOnly).toEqual([]);
    expect(unaccountedSetlistRows(handTyped, []).map((s) => s.itemId)).toEqual([
      "h1",
      "h2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// getShowReadiness's `opts` — THE ENTRY POINT PRODUCT CODE ACTUALLY CALLS.
// Round 10 built unaccountedSetlistRows, tested it thoroughly, and then shipped a
// getShowReadiness whose only caller passed two arguments, so `silent` was hard-
// wired to [] on every real call and the green "พร้อมโชว์ออฟไลน์" lie went out
// unchanged while the tests said it was fixed. These tests exercise the seam.
// (No IndexedDB in node → getReadiness counts everything as missing, which is fine:
// what is under test here is the reconciliation, not the download counts.)
// ---------------------------------------------------------------------------
describe("getShowReadiness · the setlist seam", () => {
  const rows: ShowSetlistRow[] = [
    { id: "i1", kind: "song", title: "Cruel Angel", song_id: "s1" },
    { id: "i2", kind: "mc", title: "MC", song_id: null },
    { id: "i3", kind: "song", title: "เพลงที่ถูกลบไป", song_id: null },
  ];
  const targets = [{ itemId: "i1", path: "t/g/songs/s1.mp3", name: "s1.mp3" }];

  it("reports the unaccounted row when the caller hands over the setlist", async () => {
    const r = await getShowReadiness("ev1", targets, { setlist: rows });
    expect(r.silent).toEqual([{ itemId: "i3", title: "เพลงที่ถูกลบไป" }]);
  });

  it("counts a local-only candidate as accounted for, not silent", async () => {
    // The master-less row is claimed by resolveLocalOnlyCandidates, so it must not
    // be double-reported here — "no online master" and "no audio anywhere" are
    // different problems with different fixes.
    const withMasterless: ShowSetlistRow[] = [
      ...rows,
      { id: "i4", kind: "song", title: "รออัปโหลด", song_id: "s9" },
    ];
    const r = await getShowReadiness("ev1", targets, {
      setlist: withMasterless,
      alsoAccounted: ["i4"],
    });
    expect(r.silent.map((s) => s.itemId)).toEqual(["i3"]);
  });

  it("omitting opts means NOT CHECKED — an empty silent list proves nothing", async () => {
    const r = await getShowReadiness("ev1", targets);
    expect(r.silent).toEqual([]); // …even though rows above would have flagged i3
  });
});

describe("describeSilentRows", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      itemId: `i${i}`,
      title: `เพลง ${i + 1}`,
    }));
  it("lists up to three, then counts the rest", () => {
    expect(describeSilentRows(rows(2))).toBe("เพลง 1, เพลง 2");
    expect(describeSilentRows(rows(5))).toBe("เพลง 1, เพลง 2, เพลง 3 +2");
  });
});
