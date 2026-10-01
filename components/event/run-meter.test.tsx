import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunMeter, runSegments } from "./run-meter";

describe("runSegments", () => {
  it("one segment per block, as long as the block", () => {
    expect(
      runSegments([
        { kind: "se", seconds: 30 },
        { kind: "song", seconds: 240 },
        { kind: "mc", seconds: 90 },
      ])
    ).toEqual({
      segments: [
        { kind: "se", seconds: 30 },
        { kind: "song", seconds: 240 },
        { kind: "mc", seconds: 90 },
      ],
      total: 360,
    });
  });

  it("cuts the block that crosses the slot and hatches everything past it as ONE segment", () => {
    const { segments, total } = runSegments(
      [
        { kind: "song", seconds: 200 },
        { kind: "song", seconds: 200 },
        { kind: "mc", seconds: 100 },
      ],
      300
    );
    expect(segments).toEqual([
      { kind: "song", seconds: 200 },
      { kind: "song", seconds: 100 },
      { kind: "over", seconds: 200 },
    ]);
    expect(total).toBe(500);
  });

  it("an under-filled slot ends in empty track, so widths stay proportional to the slot", () => {
    expect(runSegments([{ kind: "song", seconds: 200 }], 600)).toEqual({
      segments: [
        { kind: "song", seconds: 200 },
        { kind: "rest", seconds: 400 },
      ],
      total: 600,
    });
  });

  it("reaches the hard out so its tick always lands on the strip", () => {
    expect(runSegments([{ kind: "song", seconds: 200 }], null, 300).total).toBe(300);
  });

  it("drops empty and broken lengths (no stray 2 px gaps)", () => {
    expect(
      runSegments([
        { kind: "song", seconds: 0 },
        { kind: "se", seconds: -5 },
        { kind: "mc", seconds: Number.NaN },
        { kind: "song", seconds: 60 },
      ])
    ).toEqual({ segments: [{ kind: "song", seconds: 60 }], total: 60 });
  });
});

describe("RunMeter", () => {
  it("sizes segments by length and colours them by kind: song solid, SE at .42, MC neutral, overflow hatched", () => {
    const { container } = render(
      <RunMeter
        blocks={[
          { kind: "song", seconds: 200 },
          { kind: "se", seconds: 50 },
          { kind: "mc", seconds: 100 },
        ]}
        slotSeconds={300}
      />
    );
    const segs = Array.from(container.querySelectorAll<HTMLElement>(".dna > span"));
    expect(segs.map((s) => [s.dataset.kind, s.style.flexGrow])).toEqual([
      ["song", "200"],
      ["se", "50"],
      ["mc", "50"],
      ["over", "50"],
    ]);
    expect(segs[0].className).toBe("bg-primary");
    expect(segs[1].className).toBe("bg-primary/[.42]");
    expect(segs[2].className).toBe("bg-foreground/[.32]");
    expect(segs[3].className).toBe("hatch");
  });

  it("places the hard-out tick and the playhead along the span, clamped to the strip", () => {
    const { container } = render(
      <RunMeter blocks={[{ kind: "song", seconds: 400 }]} slotSeconds={400} hardOutSeconds={300} playheadSeconds={900} />
    );
    const tick = container.querySelector<HTMLElement>("[data-mark=hard-out]")!;
    const head = container.querySelector<HTMLElement>("[data-mark=playhead]")!;
    expect(tick.style.left).toBe("75%");
    expect(head.style.left).toBe("100%");
    // the marks stand proud of the strip, so they cannot live inside its overflow clip
    expect(tick.parentElement!.classList.contains("dna")).toBe(false);
  });

  it("is decorative unless given a label", () => {
    const quiet = render(<RunMeter blocks={[{ kind: "song", seconds: 60 }]} />).container.firstElementChild!;
    expect(quiet.getAttribute("aria-hidden")).toBe("true");
    const named = render(<RunMeter blocks={[{ kind: "song", seconds: 60 }]} label="ความยาวโชว์ 1:00" />).container
      .firstElementChild!;
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("ความยาวโชว์ 1:00");
  });
});
