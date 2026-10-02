import { fireEvent, render, screen } from "@testing-library/react";
import type { AtRule, Node } from "postcss";
import { describe, expect, it } from "vitest";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Select, SelectTrigger, SelectValue } from "./select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("fields", () => {
  // iOS Safari zooms the page in on a focused field under 16 px and never zooms back.
  it.each([
    ["Input", () => render(<Input aria-label="f" />)],
    ["Textarea", () => render(<Textarea aria-label="f" />)],
  ])("%s is 16 px on phones and draws its >= 3:1 boundary inset", (_, mount) => {
    mount();
    const c = classes(screen.getByLabelText("f"));
    expect(c.some((k) => /^text-base(\/|$)/.test(k))).toBe(true);
    expect(c.some((k) => k.startsWith("shadow-[inset_0_0_0_1.5px_hsl(var(--input))"))).toBe(true);
    // a border would shift the text by a pixel on focus; the boundary is a shadow
    expect(c).not.toContain("border");
  });

  it("a field marked invalid shows it in the boundary", () => {
    render(<Input aria-label="f" aria-invalid />);
    expect(classes(screen.getByLabelText("f")).some((k) => k.startsWith("aria-[invalid=true]:shadow-"))).toBe(true);
  });

  it("the Select trigger is the same field, 44 px", () => {
    render(
      <Select>
        <SelectTrigger aria-label="kind">
          <SelectValue placeholder="เลือก" />
        </SelectTrigger>
      </Select>
    );
    const c = classes(screen.getByRole("combobox", { name: "kind" }));
    expect(c).toContain("h-11");
    expect(c.some((k) => k.startsWith("shadow-[inset_0_0_0_1.5px_hsl(var(--input))"))).toBe(true);
  });
});

describe("Tabs", () => {
  it("are a segmented control; the active item is marked by state, not by its own colour", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList className="en">
          <TabsTrigger value="a">Summary</TabsTrigger>
          <TabsTrigger value="b">Setlist</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>
    );
    expect(classes(screen.getByRole("tablist"))).toEqual(expect.arrayContaining(["seg", "en"]));
    const b = screen.getByRole("tab", { name: "Setlist" });
    // `.seg > [data-state=active]` paints the active block; a background utility on
    // the trigger would out-rank it.
    expect(classes(b).some((k) => /(^|:)bg-/.test(k))).toBe(false);
    fireEvent.mouseDown(b);
    expect(b.getAttribute("data-state")).toBe("active");
    // hover must never repaint the active block's text in its own colour
    expect(classes(b).some((k) => k === "hover:text-foreground")).toBe(false);
  });
});

describe("Table", () => {
  // WebKit (every iPhone browser, iPad Safari, and the phone that exports the run
  // sheet JPG) paints NO box-shadow on a table-row box, and print with "background
  // graphics" off drops box-shadows everywhere. So the lines must be cell BORDERS and
  // the rail a shadow on a CELL. Measured on the compiled CSS, not the class strings:
  // a class that reads right can still compile to a selector that never matches
  // (`data-[current=true]:[&>td:first-child]` puts the attribute on the cell).
  async function compileTableCss() {
    const { default: postcss } = await import("postcss");
    const { default: tailwind } = await import("tailwindcss");
    const { default: loadConfig } = await import("tailwindcss/loadConfig");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const config = loadConfig(path.join(root, "tailwind.config.ts"));
    const css = await postcss([
      tailwind({ ...config, content: [path.join(root, "components/ui/table.tsx")] }),
    ]).process("@tailwind utilities;", { from: undefined });
    return css.css;
  }
  async function mountWithCss() {
    const style = document.createElement("style");
    style.textContent = await compileTableCss();
    document.head.appendChild(style);
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Kakumei</TableCell>
            <TableCell>3:48</TableCell>
          </TableRow>
          <TableRow data-current>
            <TableCell>Burning Red</TableCell>
            <TableCell>4:02</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Encore</TableCell>
            <TableCell>5:10</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    return () => style.remove();
  }
  const cs = (el: Element) => getComputedStyle(el);
  const hasShadow = (el: Element) => !["", "none"].includes(cs(el).boxShadow);
  /** Tailwind writes the shadow itself into --tw-shadow; box-shadow only composes it. */
  const shadowOf = (el: Element) => cs(el).getPropertyValue("--tw-shadow").trim();

  it("is one slab with display-caps heads", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
          </TableRow>
        </TableHeader>
      </Table>
    );
    const wrap = screen.getByRole("table").parentElement!;
    expect(classes(wrap)).toEqual(expect.arrayContaining(["bg-card", "shadow-edge"]));
    expect(classes(screen.getByRole("columnheader", { name: "Title" }))).toEqual(
      expect.arrayContaining(["font-display", "uppercase"])
    );
  });

  it("paints every line and the rail on CELLS — nothing on a <tr>", async () => {
    const cleanupCss = await mountWithCss();
    try {
      const rows = screen.getAllByRole("row");
      for (const tr of rows) expect(hasShadow(tr), "box-shadow on a <tr>: WebKit drops it").toBe(false);

      // the header underline and each body hairline are cell borders
      for (const th of screen.getAllByRole("columnheader")) expect(cs(th).borderBottomWidth).toBe("1px");
      const cell = (text: string) => screen.getByText(text).closest("td")!;
      expect(cs(cell("Kakumei")).borderBottomWidth).toBe("1px");
      expect(cs(cell("3:48")).borderBottomWidth).toBe("1px");

      // the current row: the rail on its first cell only, and it keeps its hairline
      expect(shadowOf(cell("Burning Red"))).toBe("inset 4px 0 0 hsl(var(--primary))");
      expect(hasShadow(cell("4:02"))).toBe(false);
      expect(hasShadow(cell("Kakumei"))).toBe(false);
      expect(cs(cell("Burning Red")).borderBottomWidth).toBe("1px");

      // the slab's own edge closes the last row
      expect(cs(cell("Encore")).borderBottomWidth).toBe("0px");
      expect(cs(cell("5:10")).borderBottomWidth).toBe("0px");
    } finally {
      cleanupCss();
    }
  });

  it("a current LAST row keeps its rail when its hairline goes", async () => {
    const cleanupCss = await mountWithCss();
    try {
      const last = screen.getByText("Encore").closest("tr")!;
      last.setAttribute("data-current", "true");
      const first = last.querySelector("td")!;
      expect(cs(first).borderBottomWidth).toBe("0px");
      expect(shadowOf(first)).toBe("inset 4px 0 0 hsl(var(--primary))");
    } finally {
      cleanupCss();
    }
  });

  // CQ-41. The slab wrapper was `overflow-auto`: any overflow but visible / clip makes a
  // box the scroll container for the sticky elements inside it, and this one never
  // scrolls vertically — so the header's `sticky top-0` never stuck to the page.
  // jsdom has no layout: this pins the classes and that they COMPILE (the sticky itself
  // was measured in a real browser — a stuck header at the header's bottom edge).
  describe("sticky header (CQ-41)", () => {
    const flat = (css: string) => css.replace(/\s+/g, " ");
    const mountBare = () =>
      render(
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Kakumei</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

    it("the slab scrolls sideways below md and only CLIPS from md, so it is not a scroll container there", async () => {
      mountBare();
      const wrap = screen.getByRole("table").parentElement!;
      expect(classes(wrap)).toEqual(expect.arrayContaining(["overflow-x-auto", "md:overflow-x-clip"]));
      // the bare `overflow-auto` is what made it a scroll container at every width
      expect(classes(wrap)).not.toContain("overflow-auto");
      expect(classes(wrap).filter((k) => /overflow-y/.test(k))).toEqual([]);

      const css = flat(await compileTableCss());
      expect(css).toMatch(/@media \(min-width: 768px\) \{[^@]*\.md\\:overflow-x-clip \{ overflow-x: clip;? \}/);
    });

    it("at md+ the header sticks UNDER the fixed app header, not at the viewport's top edge", async () => {
      mountBare();
      const thead = screen.getByRole("table").querySelector("thead")!;
      expect(classes(thead)).toContain("sticky");
      // the same offset the Event page's tab row uses (strip height included)
      const css = flat(await compileTableCss());
      expect(css).toContain(
        "top: calc(var(--header-h) + var(--offline-strip-h,0px) + env(safe-area-inset-top))"
      );
    });

    // R15 final verification. That offset was written for every width, but below md the
    // slab is overflow-x-auto — the header's scroll container — so `top` was measured
    // from the SLAB and a 52 px offset (more under a notch) pushed the header down onto
    // row 1: on every phone, in the summary JPG a phone exports, in print. Measured in
    // a real browser (head top minus table top): 52 px at 390 on screen and in print,
    // 0 once gated; at 1280 the header still sticks under the app header. jsdom has no
    // layout, so this reads WHERE in the compiled CSS each `top` can apply.
    describe("the header's offset is only where the slab is not its scroll container", () => {
      /** The at-rules a declaration sits in, e.g. ["@media (min-width:768px)", "@supports (overflow:clip)"]. */
      const guards = (node: Node): string[] => {
        const out: string[] = [];
        for (let p: Node | undefined = node.parent; p && p.type !== "root" && p.type !== "document"; p = p.parent) {
          if (p.type === "atrule") {
            const at = p as AtRule;
            out.unshift(`@${at.name} ${at.params}`.replace(/\s*:\s*/g, ":").replace(/\s+/g, " ").trim());
          }
        }
        return out;
      };
      const declsOf = async (prop: string) => {
        const { default: postcss } = await import("postcss");
        const out: { value: string; guards: string[] }[] = [];
        postcss.parse(await compileTableCss()).walkDecls(prop, (d) => {
          out.push({ value: d.value.replace(/\s+/g, " "), guards: guards(d) });
        });
        return out;
      };

      it("is offset from md up AND only where overflow: clip is supported; everywhere else the top is zero", async () => {
        mountBare();
        const thead = screen.getByRole("table").querySelector("thead")!;
        expect(classes(thead)).toContain("top-0");

        const tops = await declsOf("top");
        const offset = tops.filter((t) => t.value.includes("--header-h"));
        // exactly one offset, reachable at md+ with clip support and nowhere else
        expect(offset).toHaveLength(1);
        expect(offset[0].guards).toEqual(["@media (min-width:768px)", "@supports (overflow:clip)"]);
        // every other `top` — below md, in an old Safari — is zero
        expect(tops.filter((t) => !t.value.includes("--header-h")).map((t) => t.value)).toEqual(["0px"]);

        // the clip the offset relies on is gated on the same breakpoint, so they cannot drift apart
        const clip = (await declsOf("overflow-x")).filter((d) => d.value === "clip");
        expect(clip.map((d) => d.guards)).toEqual([[offset[0].guards[0]]]);
      });

      it("is static in print, where a page's top has no app header above it", async () => {
        mountBare();
        const thead = screen.getByRole("table").querySelector("thead")!;
        expect(classes(thead)).toContain("print:static");
        const position = await declsOf("position");
        const staticRules = position.filter((d) => d.value === "static");
        expect(staticRules.map((d) => d.guards)).toEqual([["@media print"]]);
        // it must come AFTER the base `sticky`, or it loses to it
        const order = position.map((d) => d.value);
        expect(order.indexOf("static")).toBeGreaterThan(order.indexOf("sticky"));
      });
    });

    it("the stuck header is opaque — rows slide under it", () => {
      mountBare();
      const thead = screen.getByRole("table").querySelector("thead")!;
      expect(classes(thead)).toContain("bg-card");
      expect(classes(thead).some((k) => /^bg-card\//.test(k))).toBe(false);
    });

    it("lines are drawn in the separated border model, so the header's underline travels with it", async () => {
      mountBare();
      expect(classes(screen.getByRole("table"))).toEqual(
        expect.arrayContaining(["border-separate", "border-spacing-0"])
      );
      const css = flat(await compileTableCss());
      expect(css).toMatch(/\.border-separate \{ border-collapse: separate;? \}/);
    });
  });
});
