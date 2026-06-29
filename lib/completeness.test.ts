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
  setlist: [{ kind: "song" }],
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
