// Live Mode's NOW card (FINAL-SPEC-v2 §G.10). Heights are a browser's business, but
// what decides "one height in every zone" is visible here: the SAME rows in the same
// order whatever the zone — a header strip, the title row, a fixed note line even
// when there is no note, a countdown with its fixed box, a meter, the labels. A zone
// that added or dropped a row would let the NEXT card's mic grid slide under the dock.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss, { type AtRule } from "postcss";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { NowCard } from "./now-card";
import type { LiveZone } from "@/lib/live-zone";

// A 1:32 SE: WARN at <= 0:46, URGENT at <= 0:23 (lib/live-zone thresholds).
const BLOCK = 92;
const REMAINING: Record<LiveZone, number> = { ok: 60, warn: 40, urgent: 20, over: -4 };

function card(zone: LiveZone, over: Partial<React.ComponentProps<typeof NowCard>> = {}) {
  const { container, unmount } = render(
    <NowCard
      zone={zone}
      blockSec={BLOCK}
      remaining={REMAINING[zone]}
      elapsed={BLOCK - REMAINING[zone]}
      index={2}
      total={16}
      kind="se"
      title="Opening SE"
      note={null}
      endClock="18:05:25"
      canAdvance
      {...over}
    >
      <div data-testid="fade-row" />
    </NowCard>
  );
  return { el: container.querySelector("section[data-zone]") as HTMLElement, unmount };
}

/** The card's rows, as a shape: what each direct child IS, not what it says. */
function shape(el: HTMLElement) {
  return Array.from(el.children).map((c) => {
    if (c.classList.contains("zhead")) return "header";
    if (c.querySelector("h2")) return "title";
    if (c.classList.contains("h-5")) return "note";
    if (c.querySelector(".cd-wrap")) return "countdown";
    if (c.classList.contains("track") || c.classList.contains("hatch")) return "meter";
    if (c.querySelector('[data-testid="fade-row"]')) return "children";
    return "labels";
  });
}

describe("NowCard · one shape, four zones", () => {
  it("has the same rows in the same order in ok / warn / urgent / over", () => {
    const shapes = (["ok", "warn", "urgent", "over"] as const).map((z) => {
      const { el, unmount } = card(z);
      const s = shape(el);
      // the countdown keeps the SAME fixed box whatever it shows ("1:00", "+0:04")
      expect(el.querySelector<HTMLElement>(".cd-wrap")!.style.height, z).toBe("131px");
      unmount();
      return s;
    });
    expect(shapes[0]).toEqual(["header", "title", "note", "countdown", "meter", "labels", "children"]);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it("each step is its own shape: the frame, the fill, the inversion — never the band", () => {
    expect(card("ok").el).toHaveClass("lit", "cut");
    expect(card("warn").el).toHaveClass("lit", "zone-warn");
    const urgent = card("urgent").el;
    expect(urgent).toHaveClass("lit", "zone-urgent");
    expect(urgent).not.toHaveClass("alarm-plate"); // URGENT is never the light plate
    const over = card("over").el;
    expect(over).toHaveClass("alarm-plate");
    // square (no chamfer), and loud until it has been seen for ten seconds
    for (const cls of ["lit", "cut", "settled"]) expect(over).not.toHaveClass(cls);
  });

  it("names the threshold it crossed, in the item's own scaled numbers", () => {
    expect(within(card("warn").el).getByText("Warn")).toBeTruthy();
    expect(screen.getByText("≤0:46")).toBeTruthy();
    expect(within(card("urgent").el).getByText("Urgent")).toBeTruthy();
    expect(screen.getByText("≤0:23")).toBeTruthy();
  });
});

describe("NowCard · overtime", () => {
  it("announces once under a hazard band, counts up with a +, and settles ten seconds past zero", () => {
    const { el, unmount } = card("over", { remaining: -4 });
    expect(within(el).getByRole("alert")).toHaveTextContent("Overtime · เกินเวลา");
    expect(within(el).getByRole("alert")).toHaveClass("hazard-band");
    expect(within(el).getByRole("timer")).toHaveTextContent("+0:04");
    expect(el).not.toHaveClass("settled");
    unmount();

    expect(card("over", { remaining: -10 }).el).toHaveClass("alarm-plate", "settled");
  });

  it("tells THIS device to press NEXT only when it can", () => {
    const { el, unmount } = card("over");
    expect(el).toHaveTextContent("กด NEXT เมื่อพร้อม");
    unmount();
    const locked = card("over", { canAdvance: false }).el;
    expect(locked).not.toHaveTextContent("กด NEXT");
    expect(locked).toHaveTextContent("วางไว้ 1:32");
  });

  it("no ALERT outside overtime — the ladder's other steps do not interrupt a screen reader", () => {
    for (const z of ["ok", "warn", "urgent"] as const) {
      const { el, unmount } = card(z);
      expect(within(el).queryByRole("alert"), z).toBeNull();
      unmount();
    }
  });
});

describe("NowCard · offline cached rows", () => {
  it("a row that lost its kind shows no chip instead of crashing", () => {
    const { el } = card("ok", { kind: null });
    expect(el.querySelector(".chip")).toBeNull();
    expect(within(el).getByRole("heading", { level: 2 })).toHaveTextContent("Opening SE");
  });

  it("the cue note sits on its one fixed line", () => {
    const { el } = card("ok", { note: "เปิดไฟแดงเต็มเวที" });
    const note = within(el).getByText("เปิดไฟแดงเต็มเวที");
    expect(note.closest(".h-5")).not.toBeNull();
  });
});

// ── THAI MARKS INSIDE A ONE-LINE CLIP ───────────────────────────────────────
// The title is `truncate` (overflow: hidden) at line-height 1.04 in a Barlow-first
// stack, so the clip box is the line box: +920/−120 units around the baseline. The
// Thai falls back to Kanit 700, whose stacked tone marks reach +1046 and whose ู
// reaches −270 — "สู้" lost its ู and "ปฏิวัติ" the tail of ฏ. Vertical padding
// widens the clip (overflow clips at the padding box) and the matching negative
// margin gives the room back, so the row is exactly as tall as before. jsdom has no
// layout: what is pinned is that room, never a measurement.
describe("NowCard · a Thai title keeps its tone marks and lower vowels", () => {
  it("the clipped title carries room above and below its line, cancelled by its margin", () => {
    const { el } = card("ok", { title: "หัวใจปฏิวัติ สู้ ดวงดาวที่ปลายฟ้า" });
    const h2 = within(el).getByRole("heading", { level: 2 });
    expect(h2).toHaveClass("truncate", "py-[.25em]", "-my-[.25em]");
  });
});

// ── THE CUE NOTE OF THE ITEM ON NOW ─────────────────────────────────────────
// 3ddf617 showed the whole note, capped and scrollable, on the countdown card — its
// comment: it once lived only on NEXT and "vanished the instant the item became
// current — exactly when the cue is due". The redesign's one fixed line cut a
// multi-sentence MC script to ~35 characters, with the rest in a `title` tooltip a
// phone cannot open. The line stays (the card's height is measured); a tap opens it.
describe("NowCard · the cue note of the item ON NOW", () => {
  const SCRIPT =
    "MC: ขอบคุณทุกคนที่มาวันนี้ — เพลงต่อไปเป็นเพลงใหม่ที่ยังไม่เคยเล่นที่ไหน ขอให้ทุกคนยกไฟขึ้นพร้อมกันตอนท่อนฮุก แล้วหันไปทางซ้ายเวที";

  function noteCard(props: Partial<React.ComponentProps<typeof NowCard>> = {}) {
    const all = {
      zone: "ok" as LiveZone,
      blockSec: BLOCK,
      remaining: 60,
      elapsed: BLOCK - 60,
      index: 4,
      total: 16,
      kind: "mc" as const,
      title: "MC 2",
      note: SCRIPT,
      endClock: "18:05:25",
      canAdvance: true,
      ...props,
    };
    const view = render(<NowCard {...all} />);
    const el = () => view.container.querySelector("section[data-zone]") as HTMLElement;
    return { view, el, all };
  }

  it("one fixed line until tapped, then the WHOLE script — on a phone, where a tooltip never opens", () => {
    const { el } = noteCard();
    const row = within(el()).getByRole("button", { name: SCRIPT });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(row.closest(".h-5")).not.toBeNull();
    expect(document.getElementById(row.getAttribute("aria-controls") ?? "")).toBeNull();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const full = document.getElementById(row.getAttribute("aria-controls") ?? "");
    expect(full, "the tap opened nothing").not.toBeNull();
    expect(full).toHaveTextContent(SCRIPT);
    expect(full).not.toHaveClass("truncate");
    expect(el()).toContainElement(full);
    // laid OVER the card, not into it: the card keeps its one shape (and its height)
    expect(full).toHaveClass("absolute");
    expect(shape(el())).toEqual(["header", "title", "note", "countdown", "meter", "labels"]);

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
  });

  it("an open script closes when the show moves on — the next item's cue is never hidden behind it", () => {
    const { view, el, all } = noteCard();
    fireEvent.click(within(el()).getByRole("button", { name: SCRIPT }));
    expect(within(el()).getByRole("button", { name: SCRIPT })).toHaveAttribute("aria-expanded", "true");

    view.rerender(<NowCard {...all} index={5} title="Track 5" note="ไฟสโตรบตอนจบเพลง" />);
    expect(within(el()).getByRole("button", { name: "ไฟสโตรบตอนจบเพลง" })).toHaveAttribute("aria-expanded", "false");
  });
});

// ── THE LANDSCAPE-PHONE CARD IS A PHONE'S ───────────────────────────────────
// The tight landscape card (no note row, no fade row — Live tools carries the fades
// there) is built for a phone's 390 px height. Keyed on height alone it also caught
// every mouse-driven window under 700 px tall that is not `stage:` — Chrome on a
// 1366×768 laptop, the .exe on a 768 px screen — whose NOW card then lost Auto Mute,
// MC, Auto Loudness and the cue note. jsdom has no CSS: what is pinned is the query.
const LANDSCAPE_PHONE = "[@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]";

describe("NowCard · the landscape-phone card is a touch screen's, never a short laptop window's", () => {
  const rulesIn = (el: HTMLElement) =>
    [el, ...Array.from(el.querySelectorAll("*"))]
      .flatMap((n) => (n.getAttribute("class") ?? "").split(/\s+/))
      .filter((t) => t.includes("orientation:landscape"));

  it("every landscape rule names a coarse pointer, in every zone", () => {
    for (const z of ["ok", "warn", "urgent", "over"] as const) {
      const { el, unmount } = card(z, { note: "เปิดไฟแดงเต็มเวที" });
      const rules = rulesIn(el);
      expect(rules.length, z).toBeGreaterThan(0);
      for (const r of rules) expect(r.startsWith(`${LANDSCAPE_PHONE}:`), `${z}: ${r}`).toBe(true);
      unmount();
    }
  });

  it("the fade row leaves the card only on that touch screen", () => {
    const { el } = card("ok");
    expect(within(el).getByTestId("fade-row").parentElement).toHaveClass(`${LANDSCAPE_PHONE}:hidden`);
  });
});

// ── THE STRIP'S "01 / 16" NEVER WRAPS OUT OF THE STRIP (CQ-03) ───────────────
// The strip is a fixed-height flex row: .ztag is `flex: none`, .zend is nowrap, and
// `.zidx` / `.zthr` were neither — so in URGENT at 360 / 375 (a 23 px tag) and in
// WARN / URGENT on a landscape phone (a 32 px strip in a half-width card) the index
// was the only thing allowed to shrink, collapsed to its min-content ("01 /") and
// wrapped onto 2-3 lines OUT of the strip. Four layers, each pinned here:
//   1. the index and the threshold can neither wrap nor shrink;
//   2. portrait under 390 px, URGENT's tag + gap give back ~17 px so the clock clears
//      the 18 px chamfer (380-382 was still 1-3 px short with a 380 breakpoint);
//   3. on the landscape phone the strip does not carry the index at all in WARN /
//      URGENT — the title row does, as it already does in overtime;
//   4. …nor the threshold: with the index gone, tag + threshold + clock still do not
//      fit ~218 px at 568-650, and the clock's `overflow: hidden` would then show a
//      PARTIAL time ("จบ 21:45:3"). The caption row still says "เหลือไม่ถึง N".
// jsdom has no layout: what is pinned is the rules and the classes, never a measurement.
// The harness must measure 360-389 portrait and 568-844 landscape, and its pass
// condition is `zend.scrollWidth <= zend.clientWidth` (the clock is NOT clipped) —
// `zend.right <= zhead.right - 18` alone is true by construction under overflow:hidden.
describe("NowCard · the WARN / URGENT strip's position never wraps out of the strip", () => {
  const stage = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../../app/stage.css"), "utf8"));
  const flat = (v: string) => v.replace(/\s+/g, " ").trim();
  /** declarations of every rule for `selector` inside the given at-rule params ("" = top level) */
  function decls(selector: string, media = ""): Record<string, string> {
    const out: Record<string, string> = {};
    stage.walkRules((rule) => {
      if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
      const parent = rule.parent as AtRule | undefined;
      const at = parent?.type === "atrule" ? parent.params : "";
      if (at !== media) return;
      rule.walkDecls((d) => void (out[d.prop] = flat(d.value)));
    });
    return out;
  }

  it("the index and the threshold cannot wrap or shrink; the clock may clip before anything wraps", () => {
    for (const sel of [".zidx", ".zthr"]) {
      expect(decls(sel)["white-space"], sel).toBe("nowrap");
      expect(decls(sel).flex, sel).toBe("none");
    }
    expect(decls(".zend")["min-width"]).toBe("0");
    expect(decls(".zend").overflow).toBe("hidden");
  });

  it("portrait under 390 px: URGENT's tag and gap give back room so the clock clears the chamfer", () => {
    const media = "(max-width:389.98px)";
    expect(decls(".zone-urgent .zhead", media).gap).toBe("5px");
    const tag = decls(".zone-urgent .ztag", media);
    expect(tag["font-size"]).toBe("21px");
    expect(tag.padding).toBe("0 11px 0 9px");
    // …and only there: at 390+ the approved URGENT tag is untouched
    expect(decls(".zone-urgent .ztag")["font-size"]).toBe("23px");
    expect(decls(".zone-urgent .zhead").gap).toBeUndefined();
  });

  it("landscape phone: the threshold is dropped so the clock is never clipped; nowhere else", () => {
    // the very media query now-card.tsx's `${LANDSCAPE_PHONE}:` variant spells (`_` = space)
    const media = LANDSCAPE_PHONE.replace(/^\[@media/, "").replace(/\]$/, "").replace(/_/g, " ");
    expect(media).toBe("(orientation:landscape) and (max-height:699.98px) and (pointer:coarse)");
    expect(decls(".zthr", media).display).toBe("none");
    // portrait and stage keep the threshold: it is not hidden at the top level
    expect(decls(".zthr").display).toBeUndefined();
  });

  /** the position, as the title row carries it */
  const titleRowPos = (el: HTMLElement) =>
    Array.from(el.querySelector("h2")!.parentElement!.children).find((c) => c.textContent === "02 / 16") as
      | HTMLElement
      | undefined;
  const stripIdx = (el: HTMLElement) => el.querySelector<HTMLElement>(".zhead .zidx");

  it("WARN / URGENT on a landscape phone: the strip drops the index, the title row shows it", () => {
    for (const z of ["warn", "urgent"] as const) {
      const { el, unmount } = card(z);
      expect(stripIdx(el), z).toHaveClass(`${LANDSCAPE_PHONE}:hidden`);
      const pos = titleRowPos(el);
      expect(pos, `${z}: no position in the title row`).toBeDefined();
      // hidden everywhere except that touch screen — portrait and stage keep it in the strip
      expect(pos, z).toHaveClass("hidden", `${LANDSCAPE_PHONE}:inline`);
      unmount();
    }
  });

  it("OK keeps its strip exactly as approved; overtime's title row shows it everywhere", () => {
    const ok = card("ok");
    expect(stripIdx(ok.el)).not.toHaveClass(`${LANDSCAPE_PHONE}:hidden`);
    expect(titleRowPos(ok.el)).toBeUndefined();
    ok.unmount();

    const over = card("over");
    expect(stripIdx(over.el)).toBeNull(); // the hazard band has no index of its own
    const pos = titleRowPos(over.el);
    expect(pos).toBeDefined();
    expect(pos).not.toHaveClass("hidden");
  });
});
