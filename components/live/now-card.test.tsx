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
// wrapped onto 2-3 lines OUT of the strip. Layers, each pinned here:
//   1. the index and the threshold can neither wrap nor shrink;
//   2. the strip sheds what does not fit from ITS OWN width (the next describe) —
//      the card is 308 px wide on a 1000 px iPad as much as on a 340 px phone;
//   3. on the landscape phone the strip does not carry the index at all in WARN /
//      URGENT — the title row does, as it already does in overtime;
//   4. …nor the threshold: with the index gone, tag + threshold + clock still do not
//      fit ~218 px at 568-650, and the clock's `overflow: hidden` would then show a
//      PARTIAL time ("จบ 21:45:3"). The caption row still says "เหลือไม่ถึง N".
// jsdom has no layout: what is pinned is the rules and the classes, never a measurement.
// The harness (review-shots/r15/_measure/now-strip2) must measure 320-430 portrait,
// 568-844 landscape and the 1000-1440 stage layout, and its pass condition is
// `zend.scrollWidth <= zend.clientWidth` (the clock is NOT clipped) —
// `zend.right <= zhead.right - 18` alone is true by construction under overflow:hidden.
const stage = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../../app/stage.css"), "utf8"));
const flat = (v: string) => v.replace(/\s+/g, " ").trim();
const norm = (v: string) => v.replace(/\s+/g, "");
/** the at-rules a rule sits in, outermost first */
const ancestors = (rule: postcss.Rule): AtRule[] => {
  const out: AtRule[] = [];
  for (let p = rule.parent; p && p.type === "atrule"; p = p.parent) out.unshift(p as AtRule);
  return out;
};
/** the ancestry as one whitespace-free string: "@media(...)>@container(...)" ("" = top level) */
const chainOf = (rule: postcss.Rule) => ancestors(rule).map((a) => norm(`@${a.name}${a.params}`)).join(">");
function rulesFor(selector: string, chain = ""): postcss.Rule[] {
  const out: postcss.Rule[] = [];
  stage.walkRules((rule) => {
    if (rule.selectors.map((x) => x.trim()).includes(selector) && chainOf(rule) === chain) out.push(rule);
  });
  return out;
}
/** declarations of every rule for `selector` inside `chain` ("" = top level) */
function declsAt(selector: string, chain = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rulesFor(selector, chain)) rule.walkDecls((d) => void (out[d.prop] = flat(d.value)));
  return out;
}
/** declarations of every rule for `selector` inside one media query ("" = top level) */
const decls = (selector: string, media = "") => declsAt(selector, media ? norm(`@media${media}`) : "");

describe("NowCard · the WARN / URGENT strip's position never wraps out of the strip", () => {
  it("the index and the threshold cannot wrap or shrink; the clock may clip before anything wraps", () => {
    for (const sel of [".zidx", ".zthr"]) {
      expect(decls(sel)["white-space"], sel).toBe("nowrap");
      expect(decls(sel).flex, sel).toBe("none");
    }
    expect(decls(".zend")["min-width"]).toBe("0");
    expect(decls(".zend").overflow).toBe("hidden");
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

// ── THE STRIP SHEDS FROM ITS OWN WIDTH, NOT THE VIEWPORT'S (r15) ──────────────
// The clock ("จบ 17:45:30") is the one thing the strip may never cut: a clipped clock reads
// as a believable WRONG time. The old give-back was keyed to the VIEWPORT (< 390 px), but
// the strip's width is the CARD's: in the stage layout (landscape iPad, 1000-1059 px) the
// card is 308-367 px on a wide viewport, and the clock was clipped ("จบ 17:4") there, and
// at 340 px in WARN as well. So `.zhead` is a size container and the strip drops, in this
// order and only below the width where the next step is needed, +4 px of margin:
//   1. URGENT's tag + gaps give back ~22 px  2. the threshold "≤0:23" goes  3. the index goes
// Widths measured in a real browser, Barlow Condensed + Kanit loaded
// (review-shots/r15/_measure/now-strip2/before|after): the row's items, in px.
describe("NowCard · the strip sheds, in order, from its own width", () => {
  const W = { tagWarn: 94.8, tagUrgent: 117.83, tagUrgentGiven: 106.77, thrWarn: 41.02, thrUrgent: 45.58, idx: 44.92, clock: 73.89 };
  // content-box widths the row needs (the query sees the strip MINUS its --pad both sides)
  const NEED = {
    urgentFull: W.tagUrgent + W.thrUrgent + W.idx + W.clock + 3 * 9, // 309.22
    urgentGiven: W.tagUrgentGiven + W.thrUrgent + W.idx + W.clock + 3 * 5, // 287.16
    urgentNoThr: W.tagUrgentGiven + W.idx + W.clock + 2 * 5, // 235.58
    warnFull: W.tagWarn + W.thrWarn + W.idx + W.clock + 3 * 9, // 281.63
    warnNoThr: W.tagWarn + W.idx + W.clock + 2 * 9, // 231.61
  };
  const MARGIN: [number, number] = [3, 6]; // "~4 px" — a threshold is the need plus this

  /** the max-width of the one @container rule that applies `prop: value` to `selector` */
  function containerMax(selector: string, prop: string, value: string): number {
    const hits: number[] = [];
    stage.walkAtRules("container", (at) => {
      at.walkRules((rule) => {
        if (!rule.selectors.map((x) => x.trim()).includes(selector)) return;
        rule.walkDecls(prop, (d) => {
          if (flat(d.value) === value) hits.push(parseFloat(/max-width:\s*([\d.]+)px/.exec(at.params)![1]));
        });
      });
    });
    expect(hits, `${selector} { ${prop}: ${value} } in exactly one @container`).toHaveLength(1);
    return hits[0];
  }
  const T = {
    giveBack: () => containerMax(".zone-urgent .ztag", "font-size", "21px"),
    urgentThr: () => containerMax(".zone-urgent .zthr", "display", "none"),
    warnThr: () => containerMax(".zone-warn .zthr", "display", "none"),
    urgentIdx: () => containerMax(".zone-urgent .zidx", "display", "none"),
    warnIdx: () => containerMax(".zone-warn .zidx", "display", "none"),
  };
  const margin = (threshold: number, need: number) => threshold - need;
  /** the give-back rule, found by what it does (a 21 px URGENT tag inside a container query) */
  function giveBackRule(): postcss.Rule {
    const hits: postcss.Rule[] = [];
    stage.walkRules((rule) => {
      if (!rule.selectors.map((x) => x.trim()).includes(".zone-urgent .ztag")) return;
      if (!ancestors(rule).some((a) => a.name === "container")) return;
      rule.walkDecls("font-size", (d) => void (flat(d.value) === "21px" && hits.push(rule)));
    });
    expect(hits, "one @container rule gives URGENT's tag back").toHaveLength(1);
    return hits[0];
  }

  it(".zhead is a size container, so the strip can decide from its own width", () => {
    expect(decls(".zhead")["container-type"]).toBe("inline-size");
  });

  it("each step sits at what it needs + ~4 px of margin, and the ladder goes tag, threshold, index", () => {
    const rows: [string, number, number][] = [
      ["URGENT tag gives back", T.giveBack(), NEED.urgentFull],
      ["URGENT drops the threshold", T.urgentThr(), NEED.urgentGiven],
      ["URGENT drops the index", T.urgentIdx(), NEED.urgentNoThr],
      ["WARN drops the threshold", T.warnThr(), NEED.warnFull],
      ["WARN drops the index", T.warnIdx(), NEED.warnNoThr],
    ];
    for (const [what, threshold, need] of rows) {
      expect(margin(threshold, need), `${what}: ${threshold} vs needs ${need.toFixed(2)}`).toBeGreaterThanOrEqual(MARGIN[0]);
      expect(margin(threshold, need), `${what}: ${threshold} vs needs ${need.toFixed(2)}`).toBeLessThanOrEqual(MARGIN[1]);
    }
    // the order a strip loses things as it narrows: URGENT tag → threshold → index (last resort)
    expect(T.giveBack()).toBeGreaterThan(T.urgentThr());
    expect(T.urgentThr()).toBeGreaterThan(T.urgentIdx());
    expect(T.warnThr()).toBeGreaterThan(T.warnIdx());
  });

  it("the give-back is the same 21 px tag with 5 px gaps (a container cannot style itself, so margins)", () => {
    const chain = chainOf(giveBackRule());
    const tag = declsAt(".zone-urgent .ztag", chain);
    expect(tag["font-size"]).toBe("21px");
    expect(tag.padding).toBe("0 11px 0 9px");
    // 9 px (the base gap) − 4 px = the 5 px the approved give-back used between items
    for (const sel of [".zone-urgent .ztag", ".zone-urgent .zthr", ".zone-urgent .zidx"]) {
      expect(declsAt(sel, chain)["margin-right"], sel).toBe("-4px");
    }
    expect(decls(".zhead").gap).toBe("9px");
    // …and at 390+ the approved URGENT tag is untouched
    expect(decls(".zone-urgent .ztag")["font-size"]).toBe("23px");
  });

  /** tiny media-query evaluator: orientation / pointer / min- and max-height, "and" and "," only */
  type Env = { orientation: "portrait" | "landscape"; height: number; pointer: "fine" | "coarse" };
  function matches(list: string, env: Env): boolean {
    return list.split(",").some((q) =>
      q.split(/\band\b/).every((feature) => {
        const m = /^\s*\((orientation|pointer|max-height|min-height):\s*([^)]+)\)\s*$/.exec(feature);
        if (!m) throw new Error(`media feature the test does not understand: ${feature}`);
        const [, k, v] = m;
        if (k === "orientation") return env.orientation === v;
        if (k === "pointer") return env.pointer === v;
        return k === "max-height" ? env.height <= parseFloat(v) : env.height >= parseFloat(v);
      })
    );
  }

  it("never on the landscape phone: the give-back's media is the exact complement of that phone", () => {
    const phone = LANDSCAPE_PHONE.replace(/^\[@media/, "").replace(/\]$/, "").replace(/_/g, " ");
    const media = ancestors(giveBackRule()).find((a) => a.name === "media");
    expect(media, "the give-back sits inside a @media").toBeDefined();
    const complement = flat(media!.params);
    // its strip carries only tag + clock there (201 px needed in URGENT, 218+ available): it keeps the 23 px tag
    for (const orientation of ["portrait", "landscape"] as const)
      for (const pointer of ["fine", "coarse"] as const)
        for (const height of [320, 375, 390, 699.98, 699.99, 700, 744, 900]) {
          const env = { orientation, height, pointer };
          expect(matches(complement, env), JSON.stringify(env)).toBe(!matches(phone, env));
        }
  });

  it("Safari < 16 (no container queries) keeps the old viewport rule, and only there", () => {
    const fallback = "@supportsnot(container-type:inline-size)>@media(max-width:389.98px)"; // (chains are whitespace-free)
    expect(declsAt(".zone-urgent .zhead", fallback).gap).toBe("5px");
    expect(declsAt(".zone-urgent .ztag", fallback)["font-size"]).toBe("21px");
    // a browser that has containers must decide by the strip, never by the viewport as well
    expect(decls(".zone-urgent .zhead", "(max-width:389.98px)").gap).toBeUndefined();
    expect(decls(".zone-urgent .ztag", "(max-width:389.98px)")["font-size"]).toBeUndefined();
  });
});

// ── A LONG TITLE STEPS DOWN; THE CARD KEEPS ITS HEIGHT (CQ-11) ────────────────
// "[SYSTEM_BOOT] SE (Overture)" read "[SYSTEM_BOOT] SE (Ov…" on a 390 phone: one `truncate` line
// at a fixed 26 px (40 on the stage). The title now takes one of three sizes by how many glyphs it
// has — a Thai tone mark or lower vowel is no glyph, it sits on its base. jsdom has no layout, so
// what is pinned is the table, and the one invariant that matters: the LINE BOX is the same px at
// every step. The title row is as tall as its h2, and this card is ONE height in every zone (the
// NEXT card's mic grid must never slide under the dock). A real browser still has to measure that
// the thresholds fit the real titles (review-shots/r15 shoot-real.mjs live-pre, MEASURE_JS: h2
// scrollWidth <= clientWidth at 390 and 1180) - with a Thai-heavy title too: Kanit's base glyphs are
// wider than Barlow Condensed's, so a 15-17 glyph Thai title may still be cut at the full size.
// The step table and the glyph count are what change behaviour (red on the base); the line-box,
// clip and no-row-change tests are REGRESSION GUARDS: the base passes them too, they keep the
// step-down from costing the card a pixel.
describe("NowCard · a long title steps down and the card keeps its height", () => {
  const h2Of = (title: string, zone: LiveZone = "ok") => {
    const { el, unmount } = card(zone, { title });
    return { el, h2: within(el).getByRole("heading", { level: 2 }), unmount };
  };
  const tokens = (h2: HTMLElement) => h2.className.split(/\s+/);
  /** `text-[22px]` / `stage:leading-[41.6px]` / `leading-[1.04]`: the number and its unit ("" = unitless) */
  function size(h2: HTMLElement, prefix: "" | "stage:", prop: "text" | "leading") {
    for (const t of tokens(h2)) {
      const m = new RegExp(`^${prefix}${prop}-\\[([\\d.]+)(px)?\\]$`).exec(t);
      if (m) return { n: parseFloat(m[1]), unit: m[2] ?? "" };
    }
    return null;
  }
  /** the line box in px as the browser would compute it: the size, and the leading (px, or x the size) */
  function lineBox(h2: HTMLElement, stage: boolean) {
    const fs = (stage && size(h2, "stage:", "text")) || size(h2, "", "text");
    const lh = (stage && size(h2, "stage:", "leading")) || size(h2, "", "leading");
    expect(fs, "no font size").not.toBeNull();
    expect(lh, "no line height").not.toBeNull();
    return Math.round((lh!.unit === "px" ? lh!.n : lh!.n * fs!.n) * 100) / 100;
  }
  const px = (h2: HTMLElement) => ({ phone: size(h2, "", "text")!.n, stage: size(h2, "stage:", "text")!.n });

  it("up to 17 glyphs keeps the card's own 26 / 40 px; 18-22 steps down to 22 / 32; 23 and more to 19 / 28", () => {
    for (const [n, want] of [
      [1, { phone: 26, stage: 40 }],
      [17, { phone: 26, stage: 40 }],
      [18, { phone: 22, stage: 32 }],
      [22, { phone: 22, stage: 32 }],
      [23, { phone: 19, stage: 28 }],
      [60, { phone: 19, stage: 28 }],
    ] as const) {
      const { h2, unmount } = h2Of("A".repeat(n));
      expect(px(h2), `${n} glyphs`).toEqual(want);
      unmount();
    }
  });

  it("the real titles that were cut: 27 glyphs take the smallest step, 20 the middle one", () => {
    const boot = h2Of("[SYSTEM_BOOT] SE (Overture)");
    expect(px(boot.h2)).toEqual({ phone: 19, stage: 28 });
    boot.unmount();
    const mc = h2Of("MC HBD friend ขายของ");
    expect(px(mc.h2)).toEqual({ phone: 22, stage: 32 });
  });

  it("a Thai tone mark or lower vowel is no glyph: 17 base letters with ten marks stay at full size", () => {
    const marks = "้".repeat(10); // ไม้โท, on a base letter: takes no width
    const { h2 } = h2Of("ก".repeat(17) + marks);
    expect(px(h2)).toEqual({ phone: 26, stage: 40 });
  });

  it("guard: the line box is the SAME px at every step, on the phone (27.04) and on the stage (41.6)", () => {
    for (const n of [5, 18, 30]) {
      const { h2, unmount } = h2Of("A".repeat(n));
      expect(lineBox(h2, false), `${n} glyphs, phone`).toBe(27.04);
      expect(lineBox(h2, true), `${n} glyphs, stage`).toBe(41.6);
      unmount();
    }
  });

  it("guard: every step keeps the one-line clip and the room for Thai marks (and its cancelling margin)", () => {
    for (const n of [5, 18, 30]) {
      const { h2, unmount } = h2Of("A".repeat(n));
      expect(h2, `${n}`).toHaveClass("truncate", "py-[.25em]", "-my-[.25em]", "min-w-0", "flex-1");
      unmount();
    }
  });

  it("guard: a long title changes no row: the same rows in every zone, the countdown in its fixed box, the strip untouched", () => {
    const LONG = "[SYSTEM_BOOT] SE (Overture)";
    for (const z of ["ok", "warn", "urgent", "over"] as const) {
      const short = card(z);
      const long = card(z, { title: LONG });
      expect(shape(long.el), z).toEqual(shape(short.el));
      expect(long.el.querySelector<HTMLElement>(".cd-wrap")!.style.height, z).toBe("131px");
      // the strip is the container-driven ladder's: it never learns the title's length
      expect(long.el.querySelector(".zhead")!.className, z).toBe(short.el.querySelector(".zhead")!.className);
      short.unmount();
      long.unmount();
    }
  });
});

// ── THE STAGE COUNTDOWN DOES NOT LIVE ON CONTAINER UNITS ALONE (CQ-13) ───────
// `font-size: min(var(--cd-max), calc(100cqi / …))` PARSES everywhere (var() defers the check) and
// is then invalid at computed-value time where there is no cqi (Safari < 16): the size is dropped
// and the numerals fall to the inherited ~16 px. The stage override is `!important`, so it fails
// the same way and no stylesheet fallback can sit under it. So every cq-unit override is gated on
// support, and the other branch is app/stage.css's own `.cd` rule, which this card feeds with its
// column (--cd-col) and its box's height (--cd-h) in the viewport's units. (app/stage-css.test.tsx
// holds the stylesheet's half, compiles these very classes with Tailwind and checks them against
// the columns and boxes a browser measured.)
describe("NowCard · the stage countdown's cq overrides are gated on support, with a viewport fallback", () => {
  const wrapperClasses = () => {
    const { el } = card("ok");
    return el.querySelector(".cd-wrap")!.parentElement!.className.split(/\s+/);
  };

  it("every override that uses cqi / cqb is a `stage:supports-[width:1cqi]:` one", () => {
    // (the `width:1cqi` in a support condition is no cq unit in use)
    const withCq = wrapperClasses().filter((t) => /cq[a-z]/.test(t.replace(/width:1cqi/g, "")));
    expect(withCq.length).toBeGreaterThan(0);
    for (const t of withCq) expect(t.startsWith("stage:supports-[width:1cqi]:"), t).toBe(true);
  });

  it("an engine without them is sized from the column and the box this card names, in no cq unit", () => {
    const named = wrapperClasses().filter((t) => t.includes("--cd-col:") || t.includes("--cd-h:"));
    // the phone's column, the landscape phone's, the stage's; and the stage's box height
    expect(named).toHaveLength(4);
    expect(named.some((t) => t.startsWith("[--cd-col:min(80vw,"))).toBe(true);
    expect(named.some((t) => t.startsWith("[@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:[--cd-col:calc(50vw_"))).toBe(true);
    expect(named).toContain("stage:[--cd-col:calc(100vw_-_760px)]");
    expect(named).toContain("stage:[--cd-h:calc(100vh_-_600px)]");
    for (const t of named) expect(t, t).not.toMatch(/cq/);
    // no `@supports not` font-size class: that fallback is the stylesheet's now (it was width-only)
    expect(wrapperClasses().filter((t) => t.includes("@supports_not_"))).toHaveLength(0);
  });

  it("the stage's 236 px cap is still set, whatever the engine", () => {
    expect(wrapperClasses()).toContain("stage:[&_.cd]:![--cd-max:236px]");
  });
});
