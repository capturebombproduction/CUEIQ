import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SETLIST_KIND_SHORT, type SetlistKind } from "@/lib/types";
import { KindChip, KindTile } from "./kind";
import { MicGrid } from "./mic-grid";

const KINDS = Object.keys(SETLIST_KIND_SHORT) as SetlistKind[];
const TABLE: Record<SetlistKind, [icon: string, tile: string, chip: string]> = {
  song: ["lucide-music", "kind-song", "chip-primary"],
  se: ["lucide-audio-waveform", "kind-se", "chip-neutral"],
  instrument: ["lucide-guitar", "kind-se", "chip-neutral"],
  mc: ["lucide-mic", "kind-mc", "chip-neutral"],
  guest: ["lucide-star", "kind-mc", "chip-neutral"],
  interlude: ["lucide-film", "kind-int", "chip-neutral"],
};

describe("KindTile / KindChip", () => {
  it.each(KINDS)("%s: its own icon and lightness, named for assistive tech", (kind) => {
    const [icon, tile, chip] = TABLE[kind];
    const t = render(<KindTile kind={kind} />).container.firstElementChild!;
    expect(t.classList.contains(tile)).toBe(true);
    expect(t.querySelector("svg")!.classList.contains(icon)).toBe(true);
    expect(t.getAttribute("aria-label")).toBe(SETLIST_KIND_SHORT[kind]);

    const c = render(<KindChip kind={kind} />).container.firstElementChild!;
    expect(c.classList.contains(chip)).toBe(true);
    expect(c.classList.contains("en")).toBe(true);
    expect(c.textContent).toBe(SETLIST_KIND_SHORT[kind]);
    expect(c.querySelector("svg")!.classList.contains(icon)).toBe(true);
  });

  it("only a song carries the band colour", () => {
    const solid = KINDS.filter(
      (k) => render(<KindChip kind={k} />).container.firstElementChild!.classList.contains("chip-primary")
    );
    expect(solid).toEqual(["song"]);
  });

  it("an unknown kind from older data renders neutral instead of crashing", () => {
    const c = render(<KindChip kind={"vtr" as SetlistKind} />).container.firstElementChild!;
    expect(c.textContent).toBe("VTR");
    expect(c.classList.contains("chip-neutral")).toBe(true);
  });
});

describe("MicGrid", () => {
  it("6 across on a phone, 3 × 2 at stage; colour cap, number over name; unused dimmed and said", () => {
    const { container } = render(
      <MicGrid
        mics={[
          { mic: 1, name: "Aoi", color: "#e11d48" },
          { mic: 2, name: "Rin", color: null },
          { mic: 3, off: true },
        ]}
      />
    );
    const grid = container.firstElementChild!;
    expect(grid.classList.contains("grid-cols-6")).toBe(true);
    expect(grid.classList.contains("stage:grid-cols-3")).toBe(true);
    const [a, b, c] = Array.from(grid.children) as HTMLElement[];
    expect(a.querySelector("i")!.style.background).toBe("rgb(225, 29, 72)");
    expect(a.querySelector(".num")!.textContent).toBe("1");
    expect(a.textContent).toContain("Aoi");
    expect(b.querySelector("i")).toBeNull();
    expect(c.classList.contains("off")).toBe(true);
    expect(c.textContent).toContain("ไม่ได้ใช้");
    expect(a.classList.contains("off")).toBe(false);
  });
});
