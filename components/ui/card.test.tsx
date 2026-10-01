import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Database } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./card";

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("Card", () => {
  it("is a slab by default: card fill, inset edge, no border", () => {
    const { container } = render(<Card>x</Card>);
    const c = classes(container.firstElementChild);
    expect(c).toContain("bg-card");
    expect(c).toContain("shadow-edge");
    expect(c).not.toContain("border");
  });

  // .lit draws the band key-line and rails with box-shadow; any shadow UTILITY on the
  // same element out-ranks stage.css and would erase them.
  it("hero is the lit, chamfered card and carries no shadow utility", () => {
    const { container } = render(<Card variant="hero">x</Card>);
    const c = classes(container.firstElementChild);
    expect(c).toEqual(expect.arrayContaining(["lit", "cut", "sweep"]));
    expect(c.some((k) => /^shadow-/.test(k))).toBe(false);
  });

  it("well is the L2 muted surface", () => {
    const { container } = render(<Card variant="well">x</Card>);
    const c = classes(container.firstElementChild);
    expect(c).toContain("bg-muted");
    expect(c).not.toContain("shadow-edge");
  });

  // A call site's own padding (~30 empty states write `py-16` / `py-3`) must win at
  // EVERY width. An `sm:p-5` in the base would beat it from 640 px up — the whole
  // desktop app — and collapse those empty states.
  it("a call site's padding on the parts is never overridden by a breakpoint", () => {
    render(
      <Card>
        <CardHeader className="pb-2">h</CardHeader>
        <CardContent className="py-16">c</CardContent>
        <CardFooter className="p-3">f</CardFooter>
      </Card>
    );
    for (const text of ["h", "c", "f"]) {
      const c = classes(screen.getByText(text));
      expect(c.some((k) => /^(sm|md|lg|xl):p[xytrbl]?-/.test(k)), `${text}: ${c.join(" ")}`).toBe(false);
    }
    expect(classes(screen.getByText("c"))).toContain("py-16");
    expect(classes(screen.getByText("f"))).toContain("p-3");
  });
});

describe("CardTitle", () => {
  it("an English title is display caps", () => {
    render(<CardTitle>Setlist</CardTitle>);
    expect(classes(screen.getByText("Setlist"))).toEqual(expect.arrayContaining(["font-display", "uppercase"]));
  });

  // Most titles written today are Thai; caps + tracking + the display face would
  // land on them through Kanit's fallback. The title reads its own text.
  it("a Thai title — even behind an icon — stays Kanit, no caps, no tracking", () => {
    render(
      <CardTitle>
        <Database className="h-5 w-5" /> สำรองข้อมูล (Backup อัตโนมัติ → R2)
      </CardTitle>
    );
    const c = classes(screen.getByText(/สำรองข้อมูล/));
    expect(c).toContain("font-sans");
    expect(c).not.toContain("uppercase");
    expect(c.some((k) => k.startsWith("tracking-"))).toBe(false);
  });

  it("a caller's own size still wins", () => {
    render(<CardTitle className="text-base">ข้อมูลงาน</CardTitle>);
    const c = classes(screen.getByText("ข้อมูลงาน"));
    expect(c).toContain("text-base");
    expect(c).not.toContain("text-[17px]");
  });
});
