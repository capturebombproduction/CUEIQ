import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Countdown } from "./countdown";

const cd = (container: HTMLElement) => container.querySelector<HTMLElement>(".cd")!;

/** app/stage.css's fit table: data-len → --cd-em, plus the .cd rule's own fallback. */
const fitTable = (() => {
  const root = postcss.parse(fs.readFileSync(path.resolve(__dirname, "../../app/stage.css"), "utf8"));
  const byLen = new Map<number, number>();
  let fallback = NaN;
  root.walkRules((r) => {
    const m = r.selector.match(/^\.cd\[data-len="(\d+)"\]$/);
    if (m) r.walkDecls("--cd-em", (d) => void byLen.set(Number(m[1]), parseFloat(d.value)));
    if (r.selector === ".cd")
      r.walkDecls("font-size", (d) => {
        const f = d.value.match(/var\(--cd-em,\s*([\d.]+)\)/);
        if (f) fallback = parseFloat(f[1]);
      });
  });
  return (len: number) => byLen.get(len) ?? fallback;
})();

// Each glyph's advance in em, measured in Chrome: Barlow Condensed 800, the .cd
// letter-spacing (-.01em) included, the "+" at its .8em. "2:21" is 1.818em,
// "1:00:00" 3.126, "10:00:00" 3.636, "+0:24" 2.174 — these three numbers rebuild all four.
const GLYPH_EM: Record<string, number> = { digit: 0.51, ":": 0.288, "+": 0.356 };
const widthEm = (text: string) =>
  [...text].reduce((w, ch) => w + (GLYPH_EM[ch] ?? GLYPH_EM.digit), 0);

describe("Countdown", () => {
  it("shows remaining time as m:ss with no sign and no + mark", () => {
    const { container } = render(<Countdown seconds={141} />);
    expect(cd(container).textContent).toBe("2:21");
    expect(cd(container).dataset.len).toBe("4");
    expect(container.querySelector(".plus")).toBeNull();
  });

  it("shows overtime as +m:ss (never the countdown's -), the + in its own smaller span", () => {
    const { container } = render(<Countdown seconds={-24} />);
    expect(cd(container).textContent).toBe("+0:24");
    expect(container.querySelector(".plus")?.textContent).toBe("+");
    // data-len counts the + so the fit rule picks the 5-character width.
    expect(cd(container).dataset.len).toBe("5");
  });

  it("tags each length so the fit rule can size it: 6 for +10:00, 7 for 1:00:00", () => {
    expect(cd(render(<Countdown seconds={-600} />).container).dataset.len).toBe("6");
    expect(cd(render(<Countdown seconds={3600} />).container).dataset.len).toBe("7");
  });

  // The fit is font-size = min(max, column / --cd-em), so the text fits its column
  // exactly when the rule's --cd-em is at least the string's own width in em. An hour
  // over ("+1:00:00", 8 characters) had no rule: it fell back to 1.84, stayed at
  // 164 px, measured 571 px in a 322 px NOW column, and the card clipped it to
  // "+1:00" — an hour over shown as one minute. The Caller's elapsed clock uses the
  // same Countdown and reaches "10:00:00" on an act nobody ended.
  it.each([
    0, 141, 599, 600, 3599, 3600, 35999, 36000, 359999, 360000, 3600000,
    -1, -599, -600, -3599, -3600, -35999, -36000, -359999, -360000,
  ])("%i s: the fit rule for its length is wide enough, so it never spills its column", (seconds) => {
    const el = cd(render(<Countdown seconds={seconds} />).container);
    const text = el.textContent!;
    const em = fitTable(Number(el.dataset.len));
    const px = (column: number, max: number) => widthEm(text) * Math.min(max, column / em);
    expect({ text, fits: em >= widthEm(text) }).toEqual({ text, fits: true });
    // the two columns the spec draws: phone NOW 322 px at 164, stage NOW 440 px at 236
    expect(px(322, 164)).toBeLessThanOrEqual(322);
    expect(px(440, 236)).toBeLessThanOrEqual(440);
  });

  // The NOW card keeps ONE height in every zone only if the countdown box does.
  it("reserves max × .8 whatever the text, so the card does not shrink in overtime", () => {
    const ok = render(<Countdown seconds={141} max={164} />).container.firstElementChild as HTMLElement;
    const over = render(<Countdown seconds={-24} max={164} />).container.firstElementChild as HTMLElement;
    expect(ok.style.height).toBe("131px");
    expect(over.style.height).toBe(ok.style.height);
    const stage = render(<Countdown seconds={141} max={236} />).container.firstElementChild as HTMLElement;
    expect(stage.style.height).toBe("189px");
  });

  it("can opt out of the fixed box and passes its size cap to the fit rule", () => {
    const { container } = render(<Countdown seconds={141} max={120} fixed={false} />);
    expect((container.firstElementChild as HTMLElement).style.height).toBe("");
    expect(cd(container).style.getPropertyValue("--cd-max")).toBe("120px");
  });

  it("is one text layer — no ghost digits stacked behind the numerals", () => {
    const { container } = render(<Countdown seconds={141} />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.children).toHaveLength(1);
    expect(wrap.textContent).toBe("2:21");
  });
});
