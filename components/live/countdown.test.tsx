import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Countdown } from "./countdown";

const cd = (container: HTMLElement) => container.querySelector<HTMLElement>(".cd")!;

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
