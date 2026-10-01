import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { splitEventName, TitleSlab } from "./title-slab";
import { PageTitle } from "./page-title";

describe("splitEventName", () => {
  it.each([
    ["em dash", "Japan Expo 2026 — Red Revolution", "Japan Expo 2026", "Red Revolution"],
    ["en dash", "Japan Expo 2026 – Red Revolution", "Japan Expo 2026", "Red Revolution"],
    ["spaced hyphen", "Japan Expo 2026 - Red Revolution", "Japan Expo 2026", "Red Revolution"],
    ["Thai title", "Bangkok Comic Con — คืนปฏิวัติสีแดง", "Bangkok Comic Con", "คืนปฏิวัติสีแดง"],
  ])("splits on a %s", (_, name, kicker, title) => {
    expect(splitEventName(name)).toEqual({ kicker, title });
  });

  it("splits at the FIRST separator; later dashes belong to the title", () => {
    expect(splitEventName("Tour 2026 — Night 1 - Osaka")).toEqual({ kicker: "Tour 2026", title: "Night 1 - Osaka" });
  });

  it("leaves a name with no separator whole", () => {
    expect(splitEventName("Red Revolution")).toEqual({ kicker: null, title: "Red Revolution" });
  });

  it("never cuts a hyphenated word or a date range", () => {
    expect(splitEventName("Hi-Fi Night 12-14")).toEqual({ kicker: null, title: "Hi-Fi Night 12-14" });
  });

  it("does not split off an empty side", () => {
    expect(splitEventName("Red Revolution —")).toEqual({ kicker: null, title: "Red Revolution —" });
    expect(splitEventName("  — Red Revolution")).toEqual({ kicker: null, title: "— Red Revolution" });
  });
});

describe("TitleSlab", () => {
  it("puts the kicker above and the title on the slab, as typed (never CSS caps)", () => {
    const { container } = render(<TitleSlab name="Japan Expo 2026 — Red Revolution" size={27} />);
    const kicker = container.querySelector(".poster")!;
    const slab = container.querySelector<HTMLElement>(".title-slab")!;
    expect(kicker.textContent).toBe("Japan Expo 2026");
    expect(slab.textContent).toBe("Red Revolution");
    expect(slab.style.fontSize).toBe("27px");
    expect(container.innerHTML).not.toMatch(/uppercase/);
  });

  it("with no separator the whole name goes on the slab at 75 %, allowed three lines", () => {
    const { container } = render(<TitleSlab name="Red Revolution" size={40} />);
    expect(container.querySelector(".poster")).toBeNull();
    expect(container.querySelector<HTMLElement>(".title-slab")!.style.fontSize).toBe("30px");
    expect(container.querySelector(".slab-line")!.classList.contains("line-clamp-3")).toBe(true);
  });

  it("gives a Thai title the taller line so the per-line slabs do not touch", () => {
    const thai = render(<TitleSlab name="Bangkok Comic Con — คืนปฏิวัติสีแดง" size={27} />).container;
    expect(thai.querySelector(".slab-line")!.classList.contains("thai")).toBe(true);
    const latin = render(<TitleSlab name="Bangkok Comic Con — Red Night" size={27} />).container;
    expect(latin.querySelector(".slab-line")!.classList.contains("thai")).toBe(false);
  });

  it("can be the page heading, with kicker and title in reading order", () => {
    const { getByRole } = render(<TitleSlab as="h1" name="Japan Expo 2026 — Red Revolution" size={27} />);
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Japan Expo 2026Red Revolution");
  });
});

describe("PageTitle", () => {
  it("is the display H1 with a right slot, and no ghost word until the lighting round", () => {
    const { container, getByRole } = render(<PageTitle title="Events" right={<button>New</button>} />);
    const h1 = getByRole("heading", { level: 1, name: "Events" });
    expect(h1.classList.contains("h1")).toBe(true);
    expect(container.querySelector(".page-title")!.hasAttribute("data-ghost")).toBe(false);
    expect(getByRole("button", { name: "New" })).toBeTruthy();
  });

  it("a Thai title is not forced into the 56 px italic caps", () => {
    const { getByRole } = render(<PageTitle title="ตารางงาน" />);
    expect(getByRole("heading", { level: 1 }).classList.contains("h1")).toBe(false);
  });
});
