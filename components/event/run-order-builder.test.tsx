import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { RunOrderBuilder, type RunSequence, type RunBandEvent } from "./run-order-builder";

// ─────────────────────────────────────────────────────────────────────────────
// THE RUNNING-ORDER BUILDER, RESTYLED (spec §G.4 editors).
//
// Staff build the festival order on a phone backstage as often as on a laptop. Two
// things were unusable there: the native <select>s were 14 px (iOS zooms the page
// into any focused field under 16 px and never zooms back) and ~30 px tall, and the
// delete was a bare 16 px trash glyph sitting at the end of a wrapping row. Every
// edit here broadcasts to the live คุมคิว board, so the restyle is pinned together
// with the writes it must keep sending.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/export-image", () => ({
  captureElementToImage: vi.fn(() => Promise.resolve("downloaded")),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const FEST = "A Lot Of Tone Fest";

function seq(over: Partial<RunSequence> & { id: string }): RunSequence {
  return {
    tenant_id: "t1",
    event_name: FEST,
    event_date: "2026-08-09",
    sort_order: 1,
    title: "",
    kind: "band",
    planned_start: null,
    planned_end: null,
    buffer_seconds: 0,
    linked_event_id: null,
    ...over,
  };
}

const ROWS: RunSequence[] = [
  seq({ id: "r1", sort_order: 1, title: "Seishin Kakumei", planned_start: "18:00:00", planned_end: "18:30:00", linked_event_id: "ev-1" }),
  seq({ id: "r2", sort_order: 2, title: "พักเบรก", kind: "break", buffer_seconds: 300 }),
];
const BANDS: RunBandEvent[] = [
  { id: "ev-1", group_name: "Seishin Kakumei", stage_start: "18:00:00", stage_end: "18:30:00" },
];

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", (call) =>
    call.verb === "select" ? ok(ROWS) : ok([{ id: call.eq.id }])
  );
  h.supa = supa;
});

function renderBuilder(rows: RunSequence[] = ROWS) {
  return render(
    <ConfirmProvider>
      <RunOrderBuilder
        tenantId="t1"
        eventName={FEST}
        eventDate="2026-08-09"
        initial={rows}
        bandEvents={BANDS}
      />
    </ConfirmProvider>
  );
}

const classOf = (el: Element) => el.getAttribute("class") ?? "";
const has = (el: Element, cls: string) => classOf(el).split(/\s+/).includes(cls);

/** The off-screen JPG card. */
function exportRoot(container: HTMLElement): HTMLElement {
  const sub = within(container).getByText("ลำดับงาน (Running Order)", { exact: false });
  return sub.closest<HTMLElement>("[aria-hidden]")!;
}

describe("RunOrderBuilder — a phone-sized editor (§G.4)", () => {
  it("every native select is a 44 px field with 16 px text on a phone and the ≥3:1 boundary", () => {
    const { container } = renderBuilder();
    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects).toHaveLength(4); // kind + band link, per row
    for (const s of selects) {
      expect(has(s, "h-11")).toBe(true);
      expect(has(s, "text-base")).toBe(true); // sm:text-sm only from 640 px up
      expect(classOf(s)).toContain("shadow-[inset_0_0_0_1.5px_hsl(var(--input))]");
    }
  });

  it("the row delete is a 44 px ghost trash key, like the sibling editors (§G.4)", () => {
    renderBuilder();
    const del = screen.getAllByRole("button", { name: "ลบ" });
    expect(del).toHaveLength(2);
    for (const b of del) {
      expect(has(b, "h-11") && has(b, "w-11")).toBe(true);
      // ghost: no fill, no dashed box — the trash glyph alone carries the red
      expect(has(b, "hover:bg-muted")).toBe(true);
      expect(has(b, "text-destructive")).toBe(true);
      expect(has(b, "border-dashed")).toBe(false);
      expect(b.querySelector("svg.lucide-trash-2")).not.toBeNull();
    }
  });

  it("the reorder keys are 44 × 44", () => {
    renderBuilder();
    const keys = [
      ...screen.getAllByRole("button", { name: "เลื่อนขึ้น" }),
      ...screen.getAllByRole("button", { name: "เลื่อนลง" }),
    ];
    expect(keys).toHaveLength(4);
    for (const k of keys) expect(has(k, "h-11") && has(k, "w-11")).toBe(true);
  });

  it("every control is at least 44 px tall", () => {
    const { container } = renderBuilder();
    const card = exportRoot(container);
    const small = Array.from(container.querySelectorAll("button, input, select"))
      .filter((el) => !card.contains(el))
      .filter((el) => !has(el, "h-11"))
      .map((el) => `${el.tagName} ${el.getAttribute("aria-label") ?? el.textContent} ${classOf(el)}`);
    expect(small).toEqual([]);
  });

  it("time and buffer fields set their numbers in the numeral face", () => {
    const { container } = renderBuilder();
    const nums = container.querySelectorAll('input[type="time"], input[type="number"]');
    expect(nums).toHaveLength(6);
    nums.forEach((el) => expect(has(el, "num")).toBe(true));
  });

  it("rows are slabs in a 2 px stack, with no raw palette colour", () => {
    const { container } = renderBuilder();
    // the title box (the band-link select shows the same name)
    const title = within(container)
      .getAllByDisplayValue("Seishin Kakumei")
      .find((el) => el.tagName === "INPUT")!;
    const row = title.closest(".slab");
    expect(row).not.toBeNull();
    expect(row!.parentElement!.classList.contains("stack")).toBe(true);
    const raw = Array.from(container.querySelectorAll("[class]"))
      .map(classOf)
      .filter((c) => /(^|\s)dark:|(?:bg|text|border)-(?:red|amber|emerald|sky|violet|slate|gray|zinc)-\d/.test(c));
    expect(raw).toEqual([]);
  });
});

describe("RunOrderBuilder — the JPG card stays flat and light (§D)", () => {
  it("poster title, num times, and nothing lit, chamfered, italic or dark:", () => {
    const { container } = renderBuilder();
    const card = exportRoot(container);
    expect(card.querySelector("h2")?.classList.contains("poster")).toBe(true);
    const time = within(card).getByText("18:00–18:30");
    expect(time.classList.contains("num")).toBe(true);
    expect(
      card.querySelectorAll(".lit, .cut, .ticket, .page-title, .title-slab, .hero-num, .h1, .h2, .ztag, .nlabel, .cone")
    ).toHaveLength(0);
    const classes = [card, ...Array.from(card.querySelectorAll("[class]"))].map(classOf);
    expect(classes.filter((c) => /(^|\s)dark:|italic/.test(c))).toEqual([]);
  });

  it("saving it says so in words — no emoji in the toast", async () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /บันทึกเป็นรูป/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("บันทึกรูปแล้ว");
  });
});

describe("RunOrderBuilder — the edits still go out the same way", () => {
  it("changing a row's kind autosaves that one column, asking for the row back", async () => {
    const { container } = renderBuilder();
    const kind = container.querySelectorAll("select")[0];
    fireEvent.change(kind, { target: { value: "mc" } });
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    const [u] = supa.callsTo("run_sequence", "update");
    expect(u.eq).toMatchObject({ id: "r1" });
    expect(u.values).toEqual({ kind: "mc" });
    expect(u.selectAfterWrite).toBe(true);
  });

  it("delete asks first, and only then deletes that row", async () => {
    renderBuilder();
    fireEvent.click(screen.getAllByRole("button", { name: "ลบ" })[1]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("ลบลำดับนี้?")).toBeInTheDocument();
    expect(supa.callsTo("run_sequence", "delete")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบ" }));
    await waitFor(() => expect(supa.callsTo("run_sequence", "delete")).toHaveLength(1));
    expect(supa.callsTo("run_sequence", "delete")[0].eq).toMatchObject({ id: "r2" });
  });
});
