import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { RunSeqOp } from "@/lib/run-order-outbox";
import { notify } from "@/lib/notify-client";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";
import { bandTriplet } from "@/lib/band-triplet";
import { spotFor } from "@/lib/skin";

// ─────────────────────────────────────────────────────────────────────────────
// THE FESTIVAL SHOW-CALLER, RESTYLED (spec §G.11) — and nothing else.
//
// Every press on this screen is a compare-and-swap that the whole festival runs
// on, so the restyle is pinned from both ends: the Black Stage rules it must now
// follow (one lit hero, token colour only, icon + word for every status, 44 px
// targets, a JPG report that stays flat and light) AND the writes each control
// still sends. A restyle that moved a handler onto the wrong key would read as a
// style change in review; here it reads as a red test.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown, ops: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
// The queue is what the waiting / parked banners read. Everything else in the
// outbox (overlay, flush, discard) is the real module.
vi.mock("@/lib/run-order-outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/run-order-outbox")>()),
  listRunSeqOps: async () => h.ops,
}));

const TENANT = "t1";
const FEST = "A Lot Of Tone Fest";
const FEST_DATE = "2026-08-09";
const MIN = 60_000;

// Tailwind's raw palette, the same families lib/palette-classes.test.ts guards.
const RAW_PALETTE =
  /(?<![\w-])(?:bg|text|border|ring)-(?:red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange|slate|gray|zinc|neutral|stone)-\d/;

function row(over: Partial<RunSeqLive> & { id: string }): RunSeqLive {
  return {
    sort_order: 1,
    title: "",
    kind: "band",
    planned_start: null,
    planned_end: null,
    buffer_seconds: 0,
    linked_event_id: null,
    actual_start: null,
    actual_end: null,
    status: "pending",
    offset_min: null,
    ...over,
  };
}

const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();

/** All six kinds, one done, one live (late +3), the rest pending. */
function liveBoard(liveOver: Partial<RunSeqLive> = {}): RunSeqLive[] {
  return [
    row({
      id: "r1",
      sort_order: 1,
      title: "วงเปิด",
      kind: "band",
      planned_start: "17:00:00",
      planned_end: "17:30:00",
      status: "done",
      actual_start: ago(70),
      actual_end: ago(35),
      offset_min: 2,
    }),
    row({
      id: "r2",
      sort_order: 2,
      title: "MC ช่วงเปิด",
      kind: "mc",
      planned_start: "18:00:00",
      planned_end: "18:30:00",
      status: "live",
      actual_start: ago(5),
      offset_min: 3,
      ...liveOver,
    }),
    row({ id: "r3", sort_order: 3, title: "เกมชิงรางวัล", kind: "game", planned_start: "18:30:00", planned_end: "18:45:00" }),
    row({ id: "r4", sort_order: 4, title: "พักเบรก", kind: "break", buffer_seconds: 600 }),
    row({ id: "r5", sort_order: 5, title: "พิธีมอบรางวัล", kind: "ceremony" }),
    row({ id: "r6", sort_order: 6, title: "ปิดงาน", kind: "other" }),
    row({ id: "r7", sort_order: 7, title: "Seishin Kakumei", kind: "band", linked_event_id: "ev-2" }),
  ];
}

let supa: SupabaseFake;

function script(rows: RunSeqLive[]) {
  supa.setTable("run_sequence", (call) =>
    call.verb === "update" ? ok([{ id: call.eq.id }]) : ok(rows)
  );
}

beforeEach(() => {
  h.ops = [];
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  script(liveBoard());
});

// An own property shadowing Navigator.prototype.onLine; deleting it restores jsdom's.
afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).onLine;
});
function goOffline() {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
}

function caller(rows: RunSeqLive[], over: Partial<Parameters<typeof EventLiveCaller>[0]> = {}) {
  return (
    <ConfirmProvider>
      <EventLiveCaller
        tenantId={TENANT}
        eventName={FEST}
        eventDate={FEST_DATE}
        eventId="ev-1"
        initial={rows}
        canControl
        {...over}
      />
    </ConfirmProvider>
  );
}

const renderCaller = (rows: RunSeqLive[] = liveBoard(), over = {}) => render(caller(rows, over));

/** The off-screen JPG report root (only mounted once a row is done). */
function reportRoot(container: HTMLElement): HTMLElement {
  const title = within(container).getByText("รายงานเวลาจริง (Run-time Report)", { exact: false });
  const root = title.closest<HTMLElement>("[aria-hidden]");
  expect(root).not.toBeNull();
  return root!;
}

const classOf = (el: Element) => el.getAttribute("class") ?? "";

describe("EventLiveCaller — Black Stage chrome (§G.11)", () => {
  it("a controller gets one lit hero, two chamfers (hero + NEXT key) and two glass bars", () => {
    const { container } = renderCaller();
    expect(container.querySelectorAll(".lit")).toHaveLength(1);
    expect(container.querySelectorAll(".cut")).toHaveLength(2);
    expect(container.querySelectorAll(".glass")).toHaveLength(2);
    expect(container.querySelector("header.live-top")).not.toBeNull();
    expect(container.querySelector(".dock")).not.toBeNull();
    // the hero is the NOW card, and the NOW title is the live act's own name, as typed
    const hero = container.querySelector(".lit")!;
    expect(hero.classList.contains("now")).toBe(true);
    expect(within(hero as HTMLElement).getByRole("heading", { level: 2 }).textContent).toBe("MC ช่วงเปิด");
  });

  it("a viewer gets the hero and the top bar, no dock, and is told it is read-only", () => {
    const { container } = renderCaller(liveBoard(), { canControl: false });
    expect(container.querySelectorAll(".lit")).toHaveLength(1);
    expect(container.querySelectorAll(".cut")).toHaveLength(1);
    expect(container.querySelectorAll(".glass")).toHaveLength(1);
    expect(container.querySelector(".dock")).toBeNull();
    expect(screen.getByText(/กำลังดูแบบอ่านอย่างเดียว/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /จบ \+ ต่อไป/ })).toBeNull();
  });

  it("no raw palette colour and no dark: variant anywhere, across all six kinds", () => {
    const { container } = renderCaller();
    const offenders = Array.from(container.querySelectorAll("[class]"))
      .map(classOf)
      .filter((c) => RAW_PALETTE.test(c) || /(^|\s)dark:/.test(c));
    expect(offenders).toEqual([]);
  });

  it("a break is a neutral dashed rail with a Coffee icon and the word Break", () => {
    const { container } = renderCaller();
    // the JPG report prints the title too — take the board's row
    const breakRow = within(container)
      .getAllByText("พักเบรก")
      .map((el) => el.closest<HTMLElement>(".slab"))
      .find((el) => el != null);
    expect(breakRow).toBeTruthy();
    expect(breakRow!.querySelector("svg.lucide-coffee")).not.toBeNull();
    expect(within(breakRow!).getByText("Break")).toBeInTheDocument();
    const rail = breakRow!.querySelector("i[aria-hidden]");
    expect(classOf(rail!)).toMatch(/border-dashed/);
  });

  it("statuses are an icon plus a word — no emoji or text bullets in the chrome", () => {
    const allDone = liveBoard({ status: "done", actual_end: ago(1) }).map((r) =>
      r.status === "pending" ? { ...r, status: "done", actual_start: ago(1), actual_end: ago(0) } : r
    );
    const { container } = renderCaller(allDone);
    expect(container.textContent).not.toMatch(/🎉|●|▸/u);
    const done = within(container.querySelector(".lit") as HTMLElement).getByText("จบงานแล้ว");
    expect(done.querySelector("svg")).not.toBeNull();
  });

  it("the drift reads as a token chip: late is warning + hourglass, not a red badge", () => {
    const { container } = renderCaller();
    const chip = container.querySelector(".chip-lg");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("ช้า +3 น.");
    expect(chip!.classList.contains("chip-warning")).toBe(true);
    expect(chip!.querySelector("svg.lucide-hourglass")).not.toBeNull();
  });

  it("early is info + fast-forward, on time is success", () => {
    const early = renderCaller(liveBoard({ offset_min: -2 }));
    expect(early.container.querySelector(".chip-lg.chip-info svg.lucide-fast-forward")).not.toBeNull();
    early.unmount();
    const onTime = renderCaller(liveBoard({ offset_min: 0 }));
    expect(onTime.container.querySelector(".chip-lg.chip-success")?.textContent).toBe("ตรงเวลา");
  });

  it("an act past its planned end shows the alarm chip with +overtime, and a hatch instead of the meter", () => {
    // planned 18:00–18:30 (30 min), started 40 min ago → 10 min over
    const { container } = renderCaller(liveBoard({ actual_start: ago(40) }));
    const hero = container.querySelector(".lit") as HTMLElement;
    const alarm = hero.querySelector(".chip-alarm");
    expect(alarm).not.toBeNull();
    expect(alarm!.textContent).toMatch(/^เกิน\s*\+10:0\d$/);
    expect(alarm!.querySelector("svg.lucide-octagon-alert")).not.toBeNull();
    expect(hero.querySelector(".hatch")).not.toBeNull();
    expect(hero.querySelector(".track")).toBeNull();
    // the elapsed clock is the Live countdown face, never italic
    expect(within(hero).getByRole("timer").textContent).toMatch(/^40:0\d$/);
  });

  it("the top bar carries the back link, the clock and the offline strip", () => {
    goOffline();
    const { container } = renderCaller(liveBoard(), {
      backHref: "/events/ev-1/run-order",
      backLabel: "Running Order",
    });
    const top = container.querySelector("header.live-top") as HTMLElement;
    const back = within(top).getByRole("link", { name: /Running Order/ });
    expect(back.getAttribute("href")).toBe("/events/ev-1/run-order");
    expect(within(top).getByTestId("offline-strip")).toBeInTheDocument();
    expect(within(top).getByRole("heading", { level: 1 }).textContent).toContain(FEST);
  });

  it("renders the page's notice inside the content, below the top bar", () => {
    const { container } = renderCaller(liveBoard(), { notice: <p>ระวัง — ข้อมูลเก่า</p> });
    const notice = screen.getByText("ระวัง — ข้อมูลเก่า");
    expect(notice.closest("header")).toBeNull();
    const top = container.querySelector("header.live-top")!;
    expect(top.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("every control in the caller is at least 44 px tall", async () => {
    h.ops = [
      {
        rowId: "r9",
        festival: FEST,
        patch: { status: "live" },
        expect: { status: "pending" },
        label: "เริ่ม: วงที่ชนกัน",
        queuedAt: 1,
        conflict: true,
      } satisfies RunSeqOp,
    ];
    const { container } = renderCaller(liveBoard({ linked_event_id: "ev-9" }), {
      backHref: "/events/ev-1/run-order",
      backLabel: "Running Order",
    });
    await screen.findByText("ทิ้งอันนี้");
    const report = reportRoot(container);
    const small = Array.from(container.querySelectorAll("button, a"))
      .filter((el) => !report.contains(el))
      .filter((el) => !/(^|\s)(h-11|h-12|h-14|h-16|min-h-\[44px\])(\s|$)/.test(classOf(el)))
      .map((el) => `${el.tagName} "${el.textContent}" ${classOf(el)}`);
    expect(small).toEqual([]);
  });

  it("the queued-presses banner is a warning tint with an icon, no amber", async () => {
    h.ops = [
      {
        rowId: "r3",
        festival: FEST,
        patch: { status: "live" },
        expect: { status: "pending" },
        label: "เริ่ม: เกมชิงรางวัล",
        queuedAt: 1,
      } satisfies RunSeqOp,
    ];
    renderCaller();
    const strong = await screen.findByText(/ค้างซิงค์ 1 รายการ/);
    expect(classOf(strong)).toMatch(/text-warning-ink/);
    const banner = strong.closest("div")!;
    expect(banner.querySelector("svg")).not.toBeNull();
  });
});

// At an iPad in landscape (1180 × 820) NOW (~370 px) and NEXT (~120 px) shared one
// grid row, so NEXT sat over a ~250 px hole and the Running Order started at y≈645:
// the LIVE row was under the 96 px dock until somebody scrolled — on the device that
// drives the festival. jsdom has no layout, so this pins the structure that removes
// the hole: two column wrappers, flex columns at stage and `display: contents` below
// it, with `order` keeping a phone's reading order.
describe("EventLiveCaller — the stage board is two independent columns", () => {
  const tokens = (el: Element) => classOf(el).split(/\s+/);
  const column = (el: Element) => el.closest('[class~="stage:flex-col"]');
  function parts(container: HTMLElement) {
    return {
      now: container.querySelector(".now")!,
      next: within(container).getByText("Next", { selector: "p.nlabel" }).closest("section")!,
      tools: screen.getByRole("button", { name: /ดึง buffer/ }).closest("section")!,
      board: within(container)
        .getByText("Running Order", { selector: "p.nlabel" })
        .parentElement!,
    };
  }

  it("at stage NOW sits over the tools on the left, NEXT over the Running Order on the right", () => {
    const { container } = renderCaller();
    const { now, next, tools, board } = parts(container);
    const left = column(now);
    const right = column(next);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left).not.toBe(right);
    expect(column(tools)).toBe(left);
    expect(column(board)).toBe(right);
    // the board's rows live in that right column too
    expect(right!.contains(container.querySelector(".stack"))).toBe(true);
    // two siblings of one grid: flex columns at stage, no box of their own below it
    expect(left!.parentElement).toBe(right!.parentElement);
    for (const c of [left!, right!]) {
      expect(tokens(c)).toEqual(expect.arrayContaining(["contents", "stage:flex", "stage:flex-col"]));
    }
  });

  it("below stage the reading order is still NOW, NEXT, tools, then the board", () => {
    const { container } = renderCaller();
    const { now, next, tools, board } = parts(container);
    const grid = column(now)!.parentElement!;
    // a `contents` wrapper has no box: its children are the grid's items
    const items = Array.from(grid.children).flatMap((c) =>
      tokens(c).includes("contents") ? Array.from(c.children) : [c]
    );
    const order = (el: Element) => Number(/(?:^|\s)order-(\d+)(?:\s|$)/.exec(classOf(el))?.[1] ?? 0);
    const seen = items
      .map((el, i) => ({ el, i }))
      .sort((a, b) => order(a.el) - order(b.el) || a.i - b.i)
      .map((x) => x.el);
    expect(seen).toEqual([now, next, tools, board]);
    // ≥ md (portrait tablet): NOW | NEXT side by side, the tools and board full width
    for (const el of [tools, board]) expect(tokens(el)).toContain("md:col-span-2");
  });

  it("a viewer's left column holds NOW alone, and the board still sits under NEXT", () => {
    const { container } = renderCaller(liveBoard(), { canControl: false });
    const now = container.querySelector(".now")!;
    const left = column(now)!;
    expect(left.children).toHaveLength(1);
    const next = within(container).getByText("Next", { selector: "p.nlabel" }).closest("section")!;
    expect(column(next)!.contains(container.querySelector(".stack"))).toBe(true);
  });
});

// v3 "Stage Wash" (FINAL-SPEC-v3 §E.11): the immersive caller has no app frame, so
// it hangs its own page light — first in its root, aimed at the NOW column (the
// left one from md: up), and never inside the node the JPG report is shot from.
describe("EventLiveCaller — the page light", () => {
  it("hangs ONE light, first in the root, aimed at the NOW column, outside the report", () => {
    const { container } = renderCaller();
    const lights = container.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    const light = lights[0] as HTMLElement;
    const root = container.querySelector(".live-root")!;
    expect(root.firstElementChild).toBe(light);
    expect(light).toHaveAttribute("aria-hidden", "true");
    expect(light).toHaveClass("no-print", "md:[--spot-x:31%]");
    expect(root).not.toHaveClass("isolate");
    expect(reportRoot(container).contains(light)).toBe(false);
  });
});

// §G.11 (v3): several bands share this board, so the act on stage is keyed and lit in
// ITS band — the device's own band light on another band's act names the wrong band.
// run_sequence carries no band, only the band's event (linked_event_id).
describe("EventLiveCaller — each band act in its own colour", () => {
  const skOnStage = () =>
    liveBoard({ kind: "band", title: "Seishin Kakumei", linked_event_id: "ev-sk" });

  it("keys the NOW hero in the act's band and glows in its capped stage light", async () => {
    supa.setTable("events", ok([{ id: "ev-sk", groups: { color: "#15a65a" } }]));
    const { container } = renderCaller(skOnStage());
    const hero = container.querySelector<HTMLElement>(".now.lit")!;
    await waitFor(() => expect(hero.style.getPropertyValue("--lit")).toBe(bandTriplet("#15a65a")));
    // the CAPPED light, not the raw band colour (SK Green's raw glow was a neon field)
    expect(hero.style.getPropertyValue("--lit-g")).toBe(spotFor("#15a65a").dark);
    // one read, for the linked acts only — never through the board's own refetch
    const reads = supa.callsTo("events");
    expect(reads).toHaveLength(1);
    expect(reads[0].filters).toContainEqual(expect.objectContaining({ op: "in", column: "id" }));
    expect(new Set(reads[0].filters.find((f) => f.op === "in")!.value as string[])).toEqual(
      new Set(["ev-sk", "ev-2"])
    );
  });

  it("paints a band act's rail in its own band; neutral kinds and unknown bands keep theirs", async () => {
    supa.setTable("events", ok([{ id: "ev-2", groups: { color: "#2f7fd6" } }]));
    const { container } = renderCaller();
    // the board row (NEXT and the JPG report print the title too)
    const railOf = (title: string) =>
      within(container)
        .getAllByText(title)
        .map((el) => el.closest<HTMLElement>(".slab")?.querySelector<HTMLElement>(":scope > i[aria-hidden]"))
        .find((el) => el != null)!;
    await waitFor(() => expect(railOf("Seishin Kakumei").style.getPropertyValue("--band")).toBe(bandTriplet("#2f7fd6")));
    expect(railOf("Seishin Kakumei")).toHaveClass("bg-[hsl(var(--band))]");
    // a band act with no link: the device's band, as before
    expect(railOf("วงเปิด")).toHaveClass("bg-primary");
    expect(railOf("วงเปิด").style.getPropertyValue("--band")).toBe("");
    // a game stays neutral
    expect(railOf("เกมชิงรางวัล")).toHaveClass("bg-foreground/35");
  });

  it("a colour it cannot read leaves the hero on the device's light — never a borrowed grey glow", async () => {
    supa.setTable("events", ok([{ id: "ev-sk", groups: { color: null } }]));
    const { container } = renderCaller(skOnStage());
    await waitFor(() => expect(supa.callsTo("events")[0]?.settled).toBe(true));
    const hero = container.querySelector<HTMLElement>(".now.lit")!;
    expect(hero.style.getPropertyValue("--lit")).toBe("");
    expect(hero.style.getPropertyValue("--lit-g")).toBe("");
  });
});

describe("EventLiveCaller — the JPG report stays flat and light (§D)", () => {
  it("has no lit / cut / display classes, no dark:, no italic, and is outside the hero and the bars", () => {
    const { container } = renderCaller();
    const report = reportRoot(container);
    expect(
      report.querySelectorAll(
        ".lit, .cut, .ticket, .page-title, .title-slab, .hero-num, .h1, .h2, .ztag, .nlabel, .spotlight, .glass"
      )
    ).toHaveLength(0);
    const classes = [report, ...Array.from(report.querySelectorAll("[class]"))].map(classOf);
    expect(classes.filter((c) => /(^|\s)dark:|italic/.test(c))).toEqual([]);
    expect(report.closest(".lit, .glass, .dock, .cd-wrap")).toBeNull();
    // title upright 800, numerals upright tabular (ByRole skips an aria-hidden tree)
    expect(report.querySelector("h2")?.classList.contains("poster")).toBe(true);
    expect(report.querySelectorAll("td.num").length).toBeGreaterThan(0);
    // and the kind labels it prints are unchanged
    expect(within(report).getByText("Break")).toBeInTheDocument();
    expect(within(report).getAllByText("วง", { selector: "div" })).toHaveLength(2);
  });
});

describe("EventLiveCaller — every press still sends the same write", () => {
  it("the dock's NEXT key ends the live act and starts the next, both compare-and-swap", async () => {
    renderCaller();
    fireEvent.click(screen.getByRole("button", { name: /จบ \+ ต่อไป/ }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(2));
    const [end, begin] = supa.callsTo("run_sequence", "update");
    expect(end.eq).toMatchObject({ id: "r2", status: "live" });
    expect(end.values).toMatchObject({ status: "done" });
    expect(begin.eq).toMatchObject({ id: "r3", status: "pending" });
    expect(begin.values).toMatchObject({ status: "live" });
    expect(end.selectAfterWrite && begin.selectAfterWrite).toBe(true);
  });

  it("START writes one row, guarded on pending, and pings the label once it commits", async () => {
    const fresh = liveBoard().map((r) => ({
      ...r,
      status: "pending",
      actual_start: null,
      actual_end: null,
      offset_min: null,
    }));
    script(fresh);
    renderCaller(fresh);
    fireEvent.click(screen.getByRole("button", { name: /เริ่มงาน/ }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    const [s] = supa.callsTo("run_sequence", "update");
    expect(s.eq).toMatchObject({ id: "r1", status: "pending" });
    expect(s.values).toMatchObject({ status: "live" });
    await waitFor(() => expect(notify).toHaveBeenCalledWith("run_order_live", { eventId: "ev-1" }));
  });

  it("±1 in the dock pushes the live row's drift, conditional on the value it read", async () => {
    renderCaller();
    fireEvent.click(screen.getByRole("button", { name: "เลื่อนคิว +1 นาที" }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    const [push] = supa.callsTo("run_sequence", "update");
    expect(push.eq).toMatchObject({ id: "r2", status: "live", offset_min: 3 });
    expect(push.values).toEqual({ offset_min: 4 });
  });

  // ±5 lives twice: in the phone tools strip, and as stage dock keys (CSS shows one
  // or the other). Both must push, and their names must not collide.
  it("the stage dock's −5 key pushes −5", async () => {
    renderCaller();
    fireEvent.click(screen.getByRole("button", { name: "เลื่อนคิว −5 นาที" }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    expect(supa.callsTo("run_sequence", "update")[0].values).toEqual({ offset_min: -2 });
  });

  it("the phone strip's +5 pushes +5", async () => {
    renderCaller();
    fireEvent.click(screen.getByRole("button", { name: "+5 นาที" }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    expect(supa.callsTo("run_sequence", "update")[0].values).toEqual({ offset_min: 8 });
  });

  it("the SSR HTML holds the clock placeholders and never a timezone-dependent time", () => {
    const rows = liveBoard({ actual_start: "2026-08-09T11:07:00.000Z", offset_min: 0 });
    const html = renderToString(caller(rows));
    expect(html).toContain("··:··:··");
    expect(html).toContain("0:00");
    // 18:07 Bangkok is the live act's real start — mounted-only
    expect(html).not.toContain("18:07");
    expect(html).not.toContain("chip-alarm");
  });
});
