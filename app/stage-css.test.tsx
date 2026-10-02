// What jsdom cannot lay out, pinned as the stylesheet's own text (app/stage.css, app/theme.css) and
// as the CSS Tailwind generates from the NOW card's real classes. Each block names the finding it
// holds; none of them is a measurement. A real browser still has to look (the round's harness).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postcss, { type AtRule, type Root, type Rule } from "postcss";
import tailwind from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import { render } from "@testing-library/react";
import { NowCard } from "@/components/live/now-card";
import preset from "@/tailwind.preset";
import type { LiveZone } from "@/lib/live-zone";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const stage = postcss.parse(read("app/stage.css"));
const theme = postcss.parse(read("app/theme.css"));

const flat = (v: string) => v.replace(/\s+/g, " ").trim();
const norm = (v: string) => v.replace(/\s+/g, "");
const ancestors = (node: postcss.ChildNode): AtRule[] => {
  const out: AtRule[] = [];
  for (let p: postcss.Node["parent"] = node.parent; p && p.type === "atrule"; p = p.parent) out.unshift(p as AtRule);
  return out;
};
/** the ancestry as one whitespace-free string: "@supports(width:1cqi)" ("" = top level) */
const chainOf = (node: postcss.ChildNode) => ancestors(node).map((a) => norm(`@${a.name}${a.params}`)).join(">");
const sels = (rule: Rule) => rule.selectors.map(flat);
function rules(tree: Root, selector: string, chain: string): Rule[] {
  const out: Rule[] = [];
  tree.walkRules((r) => {
    if (sels(r).includes(selector) && chainOf(r) === chain) out.push(r);
  });
  return out;
}
function decls(tree: Root, selector: string, chain = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules(tree, selector, chain)) r.walkDecls((d) => void (out[d.prop] = flat(d.value)));
  return out;
}
/** source order of a rule among every rule in the tree */
const indexOfRule = (tree: Root, rule: Rule) => {
  let i = 0;
  let found = -1;
  tree.walkRules((r) => {
    if (r === rule) found = i;
    i++;
  });
  return found;
};
const CQ_UNIT = /\d(cqi|cqb|cqw|cqh|cqmin|cqmax)\b/;
const SUPPORTS_CQ = "@supports(width:1cqi)";
const LANDSCAPE_PHONE = "@media(orientation:landscape)and(max-height:599.98px)and(pointer:coarse)";
/** the `stage` screen exactly as tailwind.preset.ts spells it (the web and the .exe both load that one) */
const stageRaw = (): string => (preset.theme!.extend!.screens as unknown as Record<string, { raw: string }>).stage.raw;

// ── CQ-13 · the Live countdown must not rely on container-query units alone ───
// `font-size: min(var(--cd-max, 164px), calc(100cqi / …))` PARSES in every browser (var() defers
// the check) and is then invalid at computed-value time where cqi does not exist (Safari < 16): the
// size is dropped, not the rule, so a plain fallback declared BEFORE it never gets a look in and the
// numerals fall to the inherited ~16 px (NOW card, the Caller's clock, the break timer). The cq rule
// therefore lives in @supports (width: 1cqi), after a viewport-based fallback.
//
// The fallback cannot know the column, so each surface names it (--cd-col) and, on the stage, its box's
// height (--cd-h). The first fallback assumed the column was about the viewport wide: true only of the
// phone NOW card. It overflowed the break timer's 100 px box and the Caller's two-column NOW card, and
// on a short stage a width-only fit overlapped the fade row (1366 x 700: 189 px of digits in a 164 px box).
describe("stage.css · the countdown (.cd) has a size where container units do not exist (CQ-13)", () => {
  it("outside @supports its font-size names no cq unit: the least of --cd-max, --cd-col / --cd-em and --cd-h / .8", () => {
    const base = decls(stage, ".cd")["font-size"];
    expect(base, ".cd has no top-level font-size").toBeTruthy();
    expect(base).not.toMatch(/cq/);
    expect(base).toBe(
      "min(var(--cd-max, 164px), calc(var(--cd-col, 100px) / var(--cd-em, 1.84)), calc(var(--cd-h, 9999px) / .8))"
    );
  });

  it("the default column is the break timer's own 100 px box: a surface that names none can never overflow it", () => {
    // the one Countdown that is not in a `.now` card (practice/break-timer.tsx)
    expect(read("components/practice/break-timer.tsx")).toMatch(/className="relative w-\[100px\]">\s*<Countdown/);
    expect(decls(stage, ".cd")["font-size"]).toContain("var(--cd-col, 100px)");
  });

  it("a `.now` card names a viewport column: one page column on a phone, the Caller's grid column from md", () => {
    const phone = decls(stage, ".now")["--cd-col"];
    const md = decls(stage, ".now", "@media(min-width:768px)")["--cd-col"];
    expect(phone).toBe("min(80vw, 100vw - 72px, 600px)");
    expect(md).toBe("min(50vw - 64px, 480px)");
    for (const v of [phone, md]) expect(v).not.toMatch(/cq/);
  });

  it("the Caller's NOW card is a bare `.now` section, so this default is what it gets", () => {
    expect(read("components/event/event-live-caller.tsx")).toMatch(/<section\s+className="now lit cut /);
    expect(read("components/event/event-live-caller.tsx")).toContain("<Countdown seconds={mounted ? Math.floor(liveElapsed) : 0} max={164} />");
  });

  it("the landscape phone needs no .cd rule of its own any more: NowCard names its half-width column", () => {
    expect(rules(stage, ".cd", LANDSCAPE_PHONE)).toHaveLength(0);
  });

  it("every declaration that uses a cq unit sits inside @supports (width: 1cqi), and there is at least one", () => {
    let seen = 0;
    stage.walkDecls((d) => {
      if (!CQ_UNIT.test(d.value)) return;
      seen++;
      expect(
        ancestors(d.parent as Rule).some((a) => norm(`@${a.name}${a.params}`) === SUPPORTS_CQ),
        `${(d.parent as Rule).selector} { ${d.prop}: ${d.value} } is a cq unit outside @supports (width: 1cqi)`
      ).toBe(true);
    });
    expect(seen).toBeGreaterThan(0);
  });

  it("the container the units measure is declared only where they exist", () => {
    stage.walkRules((r) => {
      if (!sels(r).some((s) => s.includes(".cd-wrap"))) return;
      r.walkDecls("container-type", () => {
        expect(chainOf(r), `${r.selector} declares container-type outside @supports`).toBe(SUPPORTS_CQ);
      });
    });
    expect(decls(stage, ".cd-wrap", SUPPORTS_CQ)["container-type"]).toBe("inline-size");
  });

  it("where cq units exist the size is EXACTLY what it was, and it is declared last so it wins", () => {
    const [cq] = rules(stage, ".cd", SUPPORTS_CQ);
    expect(cq, "no .cd rule inside @supports (width: 1cqi)").toBeDefined();
    expect(decls(stage, ".cd", SUPPORTS_CQ)["font-size"]).toBe(
      "min(var(--cd-max, 164px), calc(100cqi / var(--cd-em, 1.84)))"
    );
    const fallbacks = [...rules(stage, ".cd", ""), ...rules(stage, ".cd", LANDSCAPE_PHONE)];
    for (const fb of fallbacks) expect(indexOfRule(stage, cq), "the cq rule must come after the fallback").toBeGreaterThan(indexOfRule(stage, fb));
  });
});

/** One NowCard, and the classes of the box that holds its countdown */
function nowWrapperTokens(): string[] {
  const { container, unmount } = render(
    <NowCard
      zone="ok"
      blockSec={92}
      remaining={40}
      elapsed={50}
      index={2}
      total={16}
      kind="se"
      title="Opening SE"
      note={null}
      endClock="18:05:25"
      canAdvance
    />
  );
  const tokens = container.querySelector(".cd-wrap")!.parentElement!.className.split(/\s+/);
  unmount();
  return tokens;
}
/** the value inside `<prefix>…]`, as CSS (Tailwind's `_` is a space) */
function tokenValue(tokens: string[], prefix: string): string {
  const t = tokens.find((x) => x.startsWith(prefix));
  expect(t, `no ${prefix} class on the countdown's box`).toBeDefined();
  return t!.slice(prefix.length, -1).replace(/_/g, " ");
}
/** A length made of vw / vh / px, calc(), min() and max() (every form these rules use), in px at a viewport */
function len(expr: string, vw: number, vh = 0): number {
  const js = expr
    .replace(/calc/g, "")
    .replace(/min\(/g, "Math.min(")
    .replace(/max\(/g, "Math.max(")
    .replace(/(\d+(?:\.\d+)?)vw/g, (_m, n) => `(${n}*${vw}/100)`)
    .replace(/(\d+(?:\.\d+)?)vh/g, (_m, n) => `(${n}*${vh}/100)`)
    .replace(/(\d+(?:\.\d+)?)px/g, "$1");
  return Function(`"use strict"; return (${js});`)() as number;
}

describe("the NOW card's classes · Tailwind turns them into supported / unsupported branches (CQ-13)", () => {
  // The stage override is `!important` (it must beat `.cd`), so no stylesheet fallback can sit under
  // it: it is gated on support, and what Tailwind emits is what browsers read. An engine without cq
  // units gets the stylesheet's `.cd` rule instead, fed by --cd-col / --cd-h from this box.
  async function compiled(): Promise<Root> {
    let html = "";
    for (const zone of ["ok", "warn", "urgent", "over"] as LiveZone[]) {
      const { container, unmount } = render(
        <NowCard
          zone={zone}
          blockSec={92}
          remaining={zone === "over" ? -4 : 40}
          elapsed={50}
          index={2}
          total={16}
          kind="se"
          title="Opening SE"
          note={null}
          endClock="18:05:25"
          canAdvance
        />
      );
      // innerHTML escapes the & of an arbitrary variant (`[&_.cd]`); Tailwind reads the source's, not the DOM's
      html += container.innerHTML.replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"');
      unmount();
    }
    const config = loadConfig(path.join(root, "tailwind.config.ts"));
    const out = await postcss([tailwind({ ...config, content: [{ raw: html, extension: "html" }] })]).process(
      "@tailwind utilities;",
      { from: undefined }
    );
    return out.root;
  }

  // the screen as the preset spells it, a list of two ranges (the describe at the end of this
  // block pins what they are); what Tailwind emits for `stage:` is that list, whitespace aside
  const STAGE_MEDIA = "@media" + norm(stageRaw());

  it("the one `!important` font-size is the cq one, and it is generated only under @supports (width:1cqi)", async () => {
    const tree = await compiled();
    const fontSizes: string[] = [];
    tree.walkDecls("font-size", (d) => {
      const rule = d.parent as Rule;
      if (!rule.selector?.includes(".cd")) return;
      expect(d.important, `${rule.selector} must stay !important (it beats .cd)`).toBe(true);
      expect(CQ_UNIT.test(d.value), `${rule.selector}: a font-size here is the cq one`).toBe(true);
      const chain = chainOf(rule);
      expect(chain, `${rule.selector}: cq font-size`).toContain(SUPPORTS_CQ);
      expect(chain).not.toContain("@supportsnot");
      // the stage layout's: it does not leak onto the phone
      expect(chain).toContain(STAGE_MEDIA);
      fontSizes.push(d.value);
    });
    expect(fontSizes, "the cq override was not generated").toHaveLength(1);
    // the modern branch is the very string that shipped before the gate
    expect(norm(fontSizes[0])).toBe("min(var(--cd-max),calc(100cqi/var(--cd-em,1.84)),calc(100cqb/0.8))");
    // and no `@supports not` branch is left: the fallback is stylesheet's, read from the two properties below
    tree.walkAtRules("supports", (a) => expect(norm(a.params), "a leftover fallback branch").not.toContain("not"));
  }, 30_000);

  it("the column is named for the phone, the landscape phone and the stage; the box's height for the stage only", async () => {
    const tree = await compiled();
    const seen: Record<string, string[]> = {};
    tree.walkDecls(/^--cd-(col|h)$/, (d) => {
      expect(d.important, "a custom property needs no !important").toBeFalsy();
      expect(d.value, `${d.prop}: a cq unit in the fallback's input`).not.toMatch(/cq/);
      (seen[d.prop] ??= []).push(chainOf(d.parent as Rule));
    });
    expect([...(seen["--cd-col"] ?? [])].sort()).toEqual(["", LANDSCAPE_PHONE, STAGE_MEDIA].sort());
    expect(seen["--cd-h"]).toEqual([STAGE_MEDIA]);
  }, 30_000);

  it("the card is a size container on the stage layout and nowhere else; the cue note row is the one thing it asks about (CQ-20)", async () => {
    const tree = await compiled();
    // the card's own `container-type: size` (the `.cd-wrap` one inside it is a different rule)
    const containers: string[] = [];
    tree.walkDecls("container-type", (d) => {
      const rule = d.parent as Rule;
      if (rule.selector?.includes(".cd-wrap")) return;
      expect(flat(d.value), rule.selector).toBe("size");
      containers.push(chainOf(rule));
    });
    expect(containers, "the card's container rule").toEqual([STAGE_MEDIA]);
    // …and what it asks: the cue note row steps aside under 300 px of card (one class, so one rule,
    // however many zones carry it)
    const asked: string[] = [];
    tree.walkAtRules("container", (a) => {
      a.walkDecls("display", (d) => void asked.push(`${norm(a.params)} ${flat(d.value)}`));
    });
    expect(asked).toEqual(["(max-height:300px) none"]);
  }, 30_000);
});

// ── CQ-20 · the stage layout starts at 600 px tall, for a mouse AND a touch screen ──────────────
// A maximised 768p laptop's Chrome (or the .exe on a 768 px screen) has ~620-700 px, and so does an
// iPad mini's Safari tab in landscape; both used to fall out of the stage layout. The stage fits in
// 600: the NOW card's countdown box simply gets what is left. The landscape-phone layout's query
// (`max-height: 599.98px` + `pointer: coarse`, in Live, the NOW card, the Caller and stage.css) must
// stay BELOW the stage: an arbitrary @media variant is emitted AFTER the stage screen, so a device in
// both would wear the phone's `display: contents` over the stage's grid.
describe("tailwind.preset.ts · the stage screen starts at 600 px tall on any device (CQ-20)", () => {
  const ranges = () =>
    stageRaw()
      .split(",")
      .map((r) => ({
        landscape: /\(orientation:\s*landscape\)/.test(r),
        minWidth: Number(/min-width:\s*([\d.]+)px/.exec(r)?.[1]),
        minHeight: Number(/min-height:\s*([\d.]+)px/.exec(r)?.[1]),
        mouse: /\(pointer:\s*fine\)/.test(r),
      }));

  it("600 px tall and up (900 wide, landscape) is the stage on any device, touch included", () => {
    expect(ranges()).toEqual([{ landscape: true, minWidth: 900, minHeight: 600, mouse: false }]);
  });

  it("no touch screen is in the stage AND the landscape-phone layout: a range open to one starts above the phone's max-height", () => {
    const phoneMax = Number(/max-height:([\d.]+)px/.exec(LANDSCAPE_PHONE)![1]);
    expect(phoneMax).toBe(599.98);
    expect(LANDSCAPE_PHONE).toContain("and(pointer:coarse)");
    for (const r of ranges().filter((x) => !x.mouse)) expect(r.minHeight).toBeGreaterThan(phoneMax);
  });
});

// The fallback's inputs against what a real browser laid out. MEASURED, not derived: Chromium at the
// Live gallery screen with cq units ON, so the column is the .cd's own client width and the box is the
// stage's `.cd-wrap` height (always 100vh - 536 px: the stage's rows, with the fade keys and the volume
// row in the card). A fallback sizes from these, so it must stay at or under them. A real browser has to
// re-measure when the layout moves (the round's harness, NOCQ emulation); this holds the numbers.
// The 600-699 px rows (1366 x 600 / 620 / 662 / 699, 1024 x 640) are CQ-20's, from a mouse window:
// the stage starts at 600 there, and the box is 64 px at the floor. They are the box with the rows
// IN the card, which is what an engine with no container queries has: the card sheds rows only
// where container queries exist, and there the fallback is not used.
const MEASURED = {
  phone: [[360, 292], [390, 322], [430, 362], [768, 604], [820, 604]],
  landscapePhone: [[844, 356]],
  stage: [[900, 700, 160, 164], [1024, 768, 284, 232], [1112, 834, 372, 298], [1180, 820, 440, 284], [1366, 700, 626, 164], [1366, 1024, 626, 488], [1920, 1080, 1180, 544],
    [1366, 600, 626, 64], [1366, 620, 626, 84], [1366, 662, 626, 126], [1366, 699, 626, 163], [1024, 640, 314, 104]],
  caller: [[390, 322], [768, 380], [820, 410], [1024, 510], [1180, 510], [1440, 510]],
};
describe("the countdown fallback never sizes past the column or the box a browser measured (CQ-13)", () => {
  it("the evaluator reads vw / vh / px, calc(), min() and max()", () => {
    expect(len("calc(100vw - 760px)", 1180)).toBe(420);
    expect(len("min(80vw, 100vw - 72px, 600px)", 390)).toBe(312);
    expect(len("calc(100vh - 600px)", 0, 700)).toBe(100);
    expect(len("max(48px, calc(100vh - 600px))", 0, 700)).toBe(100);
    expect(len("max(48px, calc(100vh - 600px))", 0, 600)).toBe(48);
  });

  it("the NOW card's phone, landscape-phone and stage columns are each at or under the measured one", () => {
    const tokens = nowWrapperTokens();
    const phone = tokenValue(tokens, "[--cd-col:");
    const landscape = tokenValue(tokens, "[@media(orientation:landscape)_and_(max-height:599.98px)_and_(pointer:coarse)]:[--cd-col:");
    const onStage = tokenValue(tokens, "stage:[--cd-col:");
    for (const [vw, col] of MEASURED.phone) expect(len(phone, vw), `phone ${vw}`).toBeLessThanOrEqual(col);
    for (const [vw, col] of MEASURED.landscapePhone) expect(len(landscape, vw), `landscape phone ${vw}`).toBeLessThanOrEqual(col);
    for (const [vw, vh, col] of MEASURED.stage) expect(len(onStage, vw, vh), `stage ${vw}x${vh}`).toBeLessThanOrEqual(col);
  });

  it("the stage's height input is at or under the box at every measured height, down to the 600 px floor", () => {
    const h = tokenValue(nowWrapperTokens(), "stage:[--cd-h:");
    for (const [vw, vh, , box] of MEASURED.stage) {
      // the digits are .8 of the font size, and the font size is at most --cd-h / .8
      expect(len(h, vw, vh), `stage ${vw}x${vh}`).toBeLessThanOrEqual(box);
    }
  });

  it("…and it is never the 0 that 100vh - 600px is at the floor: an engine with no cq units still draws numerals (CQ-20)", () => {
    const h = tokenValue(nowWrapperTokens(), "stage:[--cd-h:");
    // every height the stage layout can have, in 1 px steps up to a tall monitor
    for (let vh = 600; vh <= 1400; vh++) expect(len(h, 1366, vh), `stage 1366x${vh}`).toBeGreaterThanOrEqual(40);
  });

  it("the Caller's `.now` columns (page column below md, the grid's from md) are under the measured ones", () => {
    const below = decls(stage, ".now")["--cd-col"];
    const fromMd = decls(stage, ".now", "@media(min-width:768px)")["--cd-col"];
    for (const [vw, col] of MEASURED.caller) expect(len(vw < 768 ? below : fromMd, vw), `Caller ${vw}`).toBeLessThanOrEqual(col);
  });
});

// ── CQ-49 · the dashboard's event card shows keyboard focus ───────────────────
describe("stage.css · .stub (the dashboard's event card) has a focus ring inside its mask (CQ-49)", () => {
  it("is masked (the reason an outer outline vanishes), and draws its ring INSIDE the box", () => {
    expect(decls(stage, ".stub").mask ?? decls(stage, ".stub")["-webkit-mask"]).toBeTruthy();
    const d = decls(stage, ".stub:focus-visible");
    expect(d.outline).toBe("2px solid hsl(var(--foreground))");
    expect(d["outline-offset"], "an outline OUTSIDE the box is clipped away by the mask").toBe("-2px");
    expect(d["box-shadow"]).toBe("inset 0 0 0 3px hsl(var(--background))");
  });
});

// ── CQ-51 · the focus ring of the SELECTED tab / segment ─────────────────────
describe("stage.css · the selected segment's focus ring reads against the page, not its ink fill (CQ-51)", () => {
  const SELECTED = [".seg > [data-state=active]:focus-visible", ".seg > .on:focus-visible"];
  const ringRule = () => {
    let hit: Rule | undefined;
    stage.walkRules((r) => {
      if (SELECTED.every((s) => sels(r).includes(s)) && chainOf(r) === "") hit = r;
    });
    expect(hit, "no focus-visible rule for the selected segment").toBeDefined();
    return hit as Rule;
  };

  it("a 2px band ring with a 2px page-coloured band inside it, and no outline", () => {
    const d: Record<string, string> = {};
    ringRule().walkDecls((x) => void (d[x.prop] = flat(x.value)));
    expect(d.outline).toBe("none");
    expect(d["box-shadow"]).toBe("inset 0 0 0 2px hsl(var(--ring)), inset 0 0 0 4px hsl(var(--background))");
  });

  it("comes after the quiet segment's selected rule, so its underline shadow does not swallow the ring", () => {
    const quiet = rules(stage, ".seg.quiet > [data-state=active]", "")[0];
    expect(quiet).toBeDefined();
    expect(indexOfRule(stage, ringRule())).toBeGreaterThan(indexOfRule(stage, quiet));
  });

  it("tabs.tsx still draws the ring this overrides (`ring-ring`, inset): the reason for the rule", () => {
    expect(read("components/ui/tabs.tsx")).toContain("focus-visible:ring-inset focus-visible:ring-ring");
  });
});

// ── CQ-36 · a touch screen gets 44 px segment items ──────────────────────────
describe("stage.css · segment items are 44 px on a coarse pointer only (CQ-36)", () => {
  const COARSE = "@media(pointer:coarse)";
  const SEL = ".seg:where(:not(.sm):not(.quiet)) > *";

  it("a mouse keeps the design's 38 px (and a dense .sm control its 30 px)", () => {
    expect(decls(stage, ".seg > *").height).toBe("38px");
    expect(decls(stage, ".seg.sm > *").height).toBe("30px");
  });

  it("a touch screen gets 44 px, for every segment but .sm and Live's .quiet", () => {
    expect(decls(stage, SEL, COARSE).height).toBe("44px");
  });

  it("is declared after the 38 px rule and keeps its specificity, so an item's own height utility still wins", () => {
    const base = rules(stage, ".seg > *", "")[0];
    const touch = rules(stage, SEL, COARSE)[0];
    expect(indexOfRule(stage, touch)).toBeGreaterThan(indexOfRule(stage, base));
    // :where() adds nothing: this is (0,1,0), the same as `.seg > *`, so utilities that come later in the
    // compiled sheet (`[&>*]:h-11` on a seg that names its own height) are not out-ranked.
    expect(SEL.startsWith(".seg:where(")).toBe(true);
  });

  it(".quiet is excluded because Live's mode switch sits in a fixed 44 px status row (38 px items + 6 px padding)", () => {
    const live = read("components/event/live-mode.tsx");
    expect(live).toMatch(/aria-label="Show mode"\s+className="seg quiet en /);
    expect(live).toMatch(/className="flex h-11 min-w-0 shrink-0 items-center gap-1\.5 /);
  });
});

// ── CQ-28 + CQ-29 · print ────────────────────────────────────────────────────
describe("theme.css · @media print (CQ-28, CQ-29)", () => {
  const printRules = () => {
    const out: Rule[] = [];
    theme.walkRules((r) => {
      if (chainOf(r) === "@mediaprint") out.push(r);
    });
    return out;
  };
  const withSelector = (s: string) => printRules().filter((r) => sels(r).includes(s));

  it("a section may split across pages: `section` is no longer in the break-inside: avoid list (CQ-28)", () => {
    const avoid = printRules().filter((r) => {
      let hit = false;
      r.walkDecls("break-inside", (d) => void (hit ||= flat(d.value) === "avoid"));
      return hit;
    });
    const selectors = avoid.flatMap(sels);
    expect(selectors).toEqual(expect.arrayContaining(["table tr", "li", "header"]));
    expect(selectors).not.toContain("section");
  });

  it("…but a section's heading never strands at the foot of a page (CQ-28)", () => {
    const [rule] = withSelector("section > h3.eyebrow");
    expect(rule, "no section > h3.eyebrow rule in @media print").toBeDefined();
    let v = "";
    rule.walkDecls("break-after", (d) => void (v = flat(d.value)));
    expect(v).toBe("avoid");
    // the run sheet's sections do open with that heading
    expect(read("components/event/event-summary.tsx")).toMatch(/<section[^>]*>\s*<h3 className="eyebrow /);
  });

  it("a toast open at print time is not printed (CQ-29)", () => {
    const [rule] = withSelector("[data-sonner-toaster]");
    expect(rule, "no [data-sonner-toaster] rule in @media print").toBeDefined();
    const d: postcss.Declaration[] = [];
    rule.walkDecls("display", (x) => void d.push(x));
    expect(d.map((x) => flat(x.value))).toEqual(["none"]);
    expect(d[0].important).toBe(true);
    // the attribute is Sonner's own on its list: components/ui/sonner.tsx wraps that library
    expect(read("components/ui/sonner.tsx")).toContain('from "sonner"');
  });
});
