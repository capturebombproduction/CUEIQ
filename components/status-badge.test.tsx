import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_META, type GroupStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./status-badge";

const STATUSES = Object.keys(STATUS_META) as GroupStatus[];
// Any pictographic emoji (⚪ 🟡 🟠 🟢 🔴 ⛔ …) or the variation selector that turns a
// text glyph into one.
const EMOJI = /\p{Extended_Pictographic}|\uFE0F/u;

const chip = (status: GroupStatus) =>
  render(<StatusBadge status={status} />).container.firstElementChild as HTMLElement;

describe("StatusBadge", () => {
  it.each(STATUSES)("%s: icon + the STATUS_META word, no emoji", (status) => {
    const el = chip(status);
    expect(el.textContent).toBe(STATUS_META[status].label);
    expect(el.textContent).not.toMatch(EMOJI);
    const icon = el.querySelector("svg");
    expect(icon, "status is never colour alone: it carries an icon").not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
  });

  // The ladder the spec sets: each status its own tone AND its own icon, so two
  // statuses never differ by colour alone.
  it("gives every status its own chip tone and its own icon", () => {
    const tone = (el: HTMLElement) =>
      [...el.classList].find((c) => /^chip-(neutral|info|warning|success|danger|alarm)$/.test(c));
    expect(STATUSES.map((s) => [s, tone(chip(s))])).toEqual([
      ["draft", "chip-neutral"],
      ["in_progress", "chip-info"],
      ["pending_review", "chip-warning"],
      ["approved", "chip-success"],
      ["rejected", "chip-danger"],
      ["overdue", "chip-alarm"],
    ]);
    const icons = STATUSES.map((s) => chip(s).querySelector("svg")!.getAttribute("class"));
    expect(new Set(icons).size).toBe(STATUSES.length);
  });

  it("is an English word, so it opts into display caps", () => {
    expect(chip("approved").classList.contains("en")).toBe(true);
  });

  it("renders an unknown status from the database as a draft, not a crash", () => {
    const el = render(<StatusBadge status={"archived" as GroupStatus} />).container
      .firstElementChild as HTMLElement;
    expect(el.textContent).toBe(STATUS_META.draft.label);
    const proto = render(<StatusBadge status={"constructor" as GroupStatus} />).container
      .firstElementChild as HTMLElement;
    expect(proto.textContent).toBe(STATUS_META.draft.label);
  });
});

describe("Badge", () => {
  it("is a chip for every variant, including the new info and alarm tones", () => {
    const cases = [
      ["default", "chip-primary"],
      ["secondary", "chip-neutral"],
      ["success", "chip-success"],
      ["warning", "chip-warning"],
      ["info", "chip-info"],
      ["destructive", "chip-danger"],
      ["alarm", "chip-alarm"],
    ] as const;
    for (const [variant, recipe] of cases) {
      const el = render(<Badge variant={variant}>x</Badge>).container.firstElementChild!;
      expect(el.classList.contains("chip"), variant).toBe(true);
      expect(el.classList.contains(recipe), variant).toBe(true);
    }
  });

  it("lets a call site's utilities restyle it (a chip is a component class, below utilities)", () => {
    const el = render(<Badge className="h-9 px-3 text-sm">x</Badge>).container.firstElementChild!;
    expect(el.className).toContain("h-9");
    expect(el.className).toContain("text-sm");
  });
});
