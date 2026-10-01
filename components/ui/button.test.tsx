import path from "node:path";
import postcss from "postcss";
import tailwind from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "./button";

const classesOf = (el: Element) => new Set((el.getAttribute("class") ?? "").split(/\s+/));

/** Compile `classes` with the app's real Tailwind config; returns the utility rules. */
async function compile(classes: string) {
  const config = loadConfig(path.resolve(__dirname, "../../tailwind.config.ts"));
  const html = `<div class="${classes.replace(/"/g, "&quot;")}"></div>`;
  const out = await postcss([
    tailwind({ ...config, content: [{ raw: html, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  const rules: { selector: string; props: Record<string, string>; media: string | null }[] = [];
  out.root.walkRules((r) => {
    if (r.parent?.type === "atrule" && /keyframes/.test((r.parent as { name: string }).name)) return;
    const props: Record<string, string> = {};
    r.walkDecls((d) => void (props[d.prop] = d.value));
    const media = r.parent?.type === "atrule" ? (r.parent as { params: string }).params : null;
    for (const selector of r.selectors) rules.push({ selector, props, media });
  });
  return rules;
}

/** Specificity of a Tailwind-generated selector: escapes collapsed, :where() = 0. */
function specificity(selector: string): [number, number, number] {
  let s = selector.replace(/\\./g, "x"); // `.\[\&_svg\]` → one class name
  // :where(...) contributes nothing; strip it with its argument.
  for (let i = s.indexOf(":where("); i !== -1; i = s.indexOf(":where(")) {
    let depth = 0;
    let j = i + ":where".length;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      if (s[j] === ")" && --depth === 0) break;
    }
    s = s.slice(0, i) + " " + s.slice(j + 1);
  }
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  const attrs = count(/\[[^\]]*\]/g);
  s = s.replace(/\[[^\]]*\]/g, " ");
  const classes = count(/\.[\w-]+/g) + count(/(?<!:):[\w-]+/g);
  s = s.replace(/\.[\w-]+/g, " ").replace(/::?[\w-]+/g, " ");
  const types = count(/(^|[\s>+~])[a-z][\w-]*/gi);
  return [0, attrs + classes, types];
}
const beats = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe("Button", () => {
  it("keeps every existing call site working: default is the primary fill, 44 px", () => {
    render(<Button>บันทึก</Button>);
    const b = screen.getByRole("button", { name: "บันทึก" });
    expect(classesOf(b).has("bg-primary")).toBe(true);
    expect(classesOf(b).has("h-11")).toBe(true);
    // Thai labels stay Kanit: display caps are opt-in, never baked in.
    expect(classesOf(b).has("uppercase")).toBe(false);
    expect(classesOf(b).has("en")).toBe(false);
  });

  it("accepts every variant the app already uses", () => {
    for (const v of ["default", "destructive", "outline", "secondary", "ghost", "link", "success"] as const) {
      expect(buttonVariants({ variant: v }), v).toBeTruthy();
    }
  });

  // The default size's h-11 must not swallow the dock / NEXT dimensions: cva emits
  // `size` after `variant`, and tailwind-merge keeps the later class.
  it("dock and next keep their own 64 px size against the default size", () => {
    const dock = buttonVariants({ variant: "dock" }).split(" ");
    expect(dock).toContain("h-16");
    expect(dock).toContain("w-16");
    expect(cn(buttonVariants({ variant: "dock" })).split(" ")).not.toContain("h-11");
    const next = cn(buttonVariants({ variant: "next" })).split(" ");
    expect(next).toContain("h-16");
    expect(next).not.toContain("h-11");
  });

  // A clip-path cuts any OUTER ring off, and ring = primary is invisible on a primary
  // fill: the chamfered key needs an inset ring and no outer one.
  it("the chamfered NEXT key focuses with an inset ring, never the clipped outer one", () => {
    render(<Button variant="next">Next</Button>);
    const c = classesOf(screen.getByRole("button", { name: "Next" }));
    expect(c.has("cut")).toBe(true);
    expect(c.has("focus-visible:ring-2")).toBe(false);
    expect(c.has("focus-visible:ring-offset-2")).toBe(false);
    expect([...c].some((k) => k.startsWith("focus-visible:shadow-[inset"))).toBe(true);
  });

  it("any Button given `cut` gets the same inset ring (Training's play key)", () => {
    render(
      <Button className="cut [--cut:14px]" aria-label="Pause">
        <Trash2 />
      </Button>
    );
    const c = classesOf(screen.getByRole("button", { name: "Pause" }));
    expect(c.has("focus-visible:ring-2")).toBe(false);
    expect([...c].some((k) => k.startsWith("focus-visible:shadow-[inset"))).toBe(true);
  });

  it("a plain Button keeps the outer focus ring", () => {
    render(<Button variant="outline">ยกเลิก</Button>);
    expect(classesOf(screen.getByRole("button", { name: "ยกเลิก" })).has("focus-visible:ring-2")).toBe(true);
  });

  it("destructive-outline is the dashed delete, not a red fill", () => {
    const c = buttonVariants({ variant: "destructive-outline" }).split(" ");
    expect(c).toContain("border-dashed");
    expect(c).not.toContain("bg-destructive");
  });
});

describe("Button icon sizing (compiled with the real Tailwind config)", () => {
  // shadcn's `[&_svg]:size-4` compiles to `.x svg` (0,1,1) and out-ranked the
  // `h-5 w-5` (0,1,0) a call site puts on its own icon: every sized icon in a Button
  // rendered at 16 px. The default must size a bare icon AND lose to any class on it.
  it.each([
    ["default", buttonVariants()],
    ["dock", buttonVariants({ variant: "dock" })],
    ["next", buttonVariants({ variant: "next" })],
  ])("%s: an icon's own size class beats the button's default icon size", async (_, base) => {
    const rules = await compile(`${base} h-5 w-5`);
    const svgSizing = rules.filter((r) => /\bsvg$/.test(r.selector) && "width" in r.props);
    expect(svgSizing.length, "the button sizes a bare icon").toBeGreaterThan(0);
    const own = rules.find((r) => r.selector === ".w-5");
    expect(own, ".w-5 never generated").toBeTruthy();
    for (const r of svgSizing) {
      expect(beats(specificity(own!.selector), specificity(r.selector)), r.selector).toBeGreaterThan(0);
    }
  });

  // `.en` (app/stage.css, a single class) must win the label face and weight over the
  // Button default. As plain `font-sans font-semibold` utilities — same specificity,
  // later in the sheet — they won, and an English Button rendered Kanit 600 in caps.
  // …while still out-weighing preflight's `button { font-weight: inherit }`, which it
  // ties at best and follows in the sheet: a bare :where() lost to it and every Thai
  // label rendered 400.
  it("an English label (`.en`) out-ranks the default face and weight; preflight does not", async () => {
    const rules = await compile(buttonVariants());
    const face = rules.filter((r) => "font-family" in r.props || "font-weight" in r.props);
    expect(face.length, "the button sets a default face").toBeGreaterThan(0);
    for (const r of face) {
      expect(beats(specificity(".en"), specificity(r.selector)), r.selector).toBeGreaterThan(0);
      expect(beats(specificity(r.selector), specificity("button")), r.selector).toBeGreaterThanOrEqual(0);
    }
  });
});
