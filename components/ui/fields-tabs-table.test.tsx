import { fireEvent, render, screen } from "@testing-library/react";
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
  async function mountWithCss() {
    const { default: postcss } = await import("postcss");
    const { default: tailwind } = await import("tailwindcss");
    const { default: loadConfig } = await import("tailwindcss/loadConfig");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const config = loadConfig(path.join(root, "tailwind.config.ts"));
    const css = await postcss([
      tailwind({ ...config, content: [path.join(root, "components/ui/table.tsx")] }),
    ]).process("@tailwind utilities;", { from: undefined });
    const style = document.createElement("style");
    style.textContent = css.css;
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
});
