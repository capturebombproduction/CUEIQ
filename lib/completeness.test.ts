import { describe, expect, it } from "vitest";
import { eventCompleteness } from "./completeness";

// Derive the exact arg shape from the function so fixtures can't drift from it.
type Args = Parameters<typeof eventCompleteness>[0];

// A fully-ready IDOL event (the richest module set: micMap + booth + costume).
// Every test starts here and knocks ONE thing out, so each assertion pins down a
// single rule in the draft → pending_review gate.
const completeIdol = (): Args => ({
  event: {
    name: "Celebrate 3rd Year",
    event_date: "2026-07-01",
    venue: "Idol Hall",
    show_start_time: "18:00",
    hard_out_time: "21:00",
    event_type: "idol",
    costume_theme: "White angels",
  },
  schedule: [
    { kind: "on_location", start_time: "15:00" },
    { kind: "dressing_room", start_time: "15:30" },
    { kind: "stb", start_time: "17:30" },
    { kind: "stage", start_time: "18:00" },
    { kind: "booth", start_time: "20:00" },
  ],
  setlist: [{ kind: "song", title: "Cruel Angel's Thesis" }],
  micCount: 3,
  hasSongMics: false,
});

const keys = (a: Args) => eventCompleteness(a).missing.map((m) => m.key);

describe("eventCompleteness — a ready idol event", () => {
  it("reports complete with nothing missing", () => {
    const r = eventCompleteness(completeIdol());
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe("required event fields", () => {
  it("flags each blank core field", () => {
    const cases: [keyof Args["event"], string][] = [
      ["name", "name"],
      ["venue", "venue"],
      ["show_start_time", "show_start_time"],
      ["hard_out_time", "hard_out_time"],
    ];
    for (const [field, key] of cases) {
      const a = completeIdol();
      (a.event as Record<string, unknown>)[field] = "";
      expect(keys(a)).toContain(key);
      expect(eventCompleteness(a).complete).toBe(false);
    }
  });
  it("treats whitespace-only as blank", () => {
    const a = completeIdol();
    a.event.name = "   ";
    expect(keys(a)).toContain("name");
  });
  it("flags a missing event_date", () => {
    const a = completeIdol();
    a.event.event_date = "";
    expect(keys(a)).toContain("event_date");
  });
});

describe("schedule call-times", () => {
  it("flags any missing required call-time", () => {
    for (const kind of ["on_location", "dressing_room", "stb", "stage"] as const) {
      const a = completeIdol();
      a.schedule = a.schedule.filter((s) => s.kind !== kind);
      expect(keys(a)).toContain(`sched_${kind}`);
    }
  });
  it("a call-time row with a blank time does not count as filled", () => {
    const a = completeIdol();
    a.schedule = a.schedule.map((s) =>
      s.kind === "stage" ? { ...s, start_time: "" } : s
    );
    expect(keys(a)).toContain("sched_stage");
  });
  it("requires booth only for module types that have it (idol yes)", () => {
    const a = completeIdol();
    a.schedule = a.schedule.filter((s) => s.kind !== "booth");
    expect(keys(a)).toContain("sched_booth");
  });
});

describe("setlist + mic + costume", () => {
  it("needs at least one SONG (a non-song row doesn't count)", () => {
    const a = completeIdol();
    a.setlist = [{ kind: "mc" } as Args["setlist"][number]];
    expect(keys(a)).toContain("setlist");
  });
  it("an event-level Mic Map satisfies the mic gate", () => {
    const a = completeIdol();
    a.micCount = 0;
    a.hasSongMics = false;
    expect(keys(a)).toContain("mic");
  });
  it("per-song mics ALSO satisfy the mic gate (the two systems are linked)", () => {
    const a = completeIdol();
    a.micCount = 0;
    a.hasSongMics = true;
    expect(keys(a)).not.toContain("mic");
  });
  it("flags a missing costume theme for idol", () => {
    const a = completeIdol();
    a.event.costume_theme = "";
    expect(keys(a)).toContain("costume");
  });
});

// ---------------------------------------------------------------------------
// Song rows with no NAME. "+ เพลง" inserts `title: ""`, so a band lands here by
// pressing a button and walking away, and an unnamed row is unreadable on the run
// sheet at the venue.
//
// This block does NOT cover "the song was deleted": ON DELETE SET NULL (migration
// 0012) leaves the row's title intact and only nulls song_id, which is identical to
// a hand-typed row — see the comment in lib/completeness.ts and the tests below.
// ---------------------------------------------------------------------------
describe("setlist rows with no title", () => {
  it("a blank-titled song row does not count as a song, and is named", () => {
    const a = completeIdol();
    a.setlist = [{ kind: "song", title: "   " }];
    const k = keys(a);
    expect(k).toContain("setlist"); // it was the only "song" — the set has none
    expect(k).toContain("setlist_untitled");
    expect(eventCompleteness(a).complete).toBe(false);
  });

  it("blocks even when the other songs are fine — a mystery row is not shippable", () => {
    const a = completeIdol();
    a.setlist = [
      { kind: "song", title: "Cruel Angel's Thesis" },
      { kind: "song", title: "" },
    ];
    const k = keys(a);
    expect(k).not.toContain("setlist"); // one real song is present
    expect(k).toContain("setlist_untitled");
    expect(eventCompleteness(a).complete).toBe(false);
  });

  it("names how many rows are unnamed", () => {
    const a = completeIdol();
    a.setlist = [
      { kind: "song", title: "Cruel Angel's Thesis" },
      { kind: "song", title: "" },
      { kind: "song", title: "" },
    ];
    const item = eventCompleteness(a).missing.find((m) => m.key === "setlist_untitled");
    expect(item?.label).toContain("2");
  });

  it("a blank MC/SE row is untouched — those are not songs", () => {
    const a = completeIdol();
    a.setlist = [
      { kind: "song", title: "Cruel Angel's Thesis" },
      { kind: "mc", title: "" },
      { kind: "se", title: "   " },
      // A deliberate non-song slot: a break, a costume change, a VTR. Blank or not,
      // these must never be reported as incomplete — silence is the point of them.
      { kind: "interlude", title: "" },
      { kind: "guest", title: "   " },
      { kind: "instrument", title: "" },
    ];
    expect(eventCompleteness(a).complete).toBe(true);
  });

  // THE REGRESSION THAT MATTERS MOST. The Overview boards map rows down to
  // `{ kind }` before calling this. An absent title must keep the old lenient
  // reading — reading `undefined` as blank would have flagged every song of every
  // event on both boards at once.
  it("a caller that does not pass titles gets exactly the old behaviour", () => {
    const a = completeIdol();
    a.setlist = [{ kind: "song" }, { kind: "mc" }];
    const r = eventCompleteness(a);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE RULE THAT WAS REMOVED, PINNED SO IT DOES NOT COME BACK.
//
// Round 10 added a `librarySongIds` parameter that flagged any row whose song_id
// was absent from the list the caller handed over ("ไฟล์หายไปจากคลัง"). The repair
// pass deleted it. `setlist_items.song_id` is a real FK with ON DELETE SET NULL, so
// a non-null song_id ALWAYS resolves to a live songs row — measured on prod: 0 of
// 112 song rows across 44 events pointed outside the library. The branch could only
// ever go true when the caller's library list came back short (a failed, paginated
// or wrongly-scoped read), and A FAILED READ IS NOT A ZERO COUNT: it would have
// declared a healthy setlist broken and auto-reverted an approved show to Draft.
//
// So: this gate judges NAMES, never LINKS. Whether a row will make a sound is
// answered in lib/show-readiness.ts, where the device can actually check.
// ---------------------------------------------------------------------------
describe("the gate never judges library links", () => {
  it("a hand-typed song row (no library link) is complete", () => {
    const a = completeIdol();
    a.setlist = [{ kind: "song", title: "เพลงใหม่ยังไม่เข้าคลัง" }];
    expect(eventCompleteness(a).complete).toBe(true);
  });

  it("a row whose song was deleted is indistinguishable from a hand-typed one, and stays complete", () => {
    // ON DELETE SET NULL keeps the title and nulls only song_id, so this fixture IS
    // the post-delete row. The gate must not guess; the preflight answers it.
    const a = completeIdol();
    a.setlist = [
      { kind: "song", title: "Cruel Angel's Thesis" },
      { kind: "song", title: "Zankoku" }, // its song was deleted out from under it
    ];
    const r = eventCompleteness(a);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("takes no library argument at all — and an extra one changes no verdict", () => {
    // THIS ASSERTS AGAINST THE FUNCTION, NOT THE FIXTURE. The first version of this
    // test read `Object.keys(completeIdol())` and checked the key was absent — but
    // completeIdol() is a local literal that never sets it, so the assertion was true
    // for EVERY possible state of lib/completeness.ts. Re-adding the parameter and
    // the whole `setlist_orphan` branch would have left it green, while its own
    // comment told the next reader the removal was enforced. A test that cannot fail
    // is not a test.
    //
    // Two guards now, one per layer. COMPILE TIME: `@ts-expect-error` below is
    // satisfied only while `librarySongIds` is an excess property — the day someone
    // re-declares the parameter the directive becomes unused and `npx tsc --noEmit`
    // fails on THIS LINE (lib/**/*.ts is in tsconfig include). Read the comment block
    // above before you delete it. RUN TIME: the verdict must stay `complete` even so,
    // because a genuinely inert extra argument is harmless — it is the BRANCH, not
    // the parameter, that would auto-revert a healthy show to Draft.
    // @ts-expect-error re-adding a library-links parameter to the gate must not compile
    expect(eventCompleteness({ ...completeIdol(), librarySongIds: [] }).complete).toBe(true);
  });
});

describe("module-aware requirements per event_type", () => {
  it("live_band needs mics but NOT booth or costume", () => {
    const a = completeIdol();
    a.event.event_type = "live_band";
    a.event.costume_theme = "";
    a.schedule = a.schedule.filter((s) => s.kind !== "booth");
    a.micCount = 2;
    const k = keys(a);
    expect(k).not.toContain("sched_booth");
    expect(k).not.toContain("costume");
    expect(k).not.toContain("mic");
    expect(eventCompleteness(a).complete).toBe(true);
  });
  it("wedding / corporate drop mic, booth and costume entirely", () => {
    for (const t of ["wedding", "corporate"] as const) {
      const a = completeIdol();
      a.event.event_type = t;
      a.event.costume_theme = "";
      a.schedule = a.schedule.filter((s) => s.kind !== "booth");
      a.micCount = 0;
      a.hasSongMics = false;
      const k = keys(a);
      expect(k).not.toContain("mic");
      expect(k).not.toContain("sched_booth");
      expect(k).not.toContain("costume");
      expect(eventCompleteness(a).complete).toBe(true);
    }
  });
  it("an unknown event_type defensively falls back to the idol module set", () => {
    const a = completeIdol();
    a.event.event_type = "mystery" as unknown as Args["event"]["event_type"];
    a.event.costume_theme = "";
    a.schedule = a.schedule.filter((s) => s.kind !== "booth");
    a.micCount = 0;
    a.hasSongMics = false;
    const k = keys(a);
    // idol-equivalent: booth + costume + mic all required again.
    expect(k).toContain("sched_booth");
    expect(k).toContain("costume");
    expect(k).toContain("mic");
  });
});
