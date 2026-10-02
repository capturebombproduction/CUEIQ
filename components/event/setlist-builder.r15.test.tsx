// Round 15, the Setlist tab's editor.
//
// CQ-26  An EMPTY set drew a green "อยู่ในเวลา · เหลือ 3:15:00 ก่อน Hard Out": the
//        success state rendered whenever a hard out existed and the set was not over,
//        with no branch for "there is nothing in it". Nothing to be on time with is not
//        in time. The alarm (over the hard out) is unchanged.
// CQ-42  The overlap label "เล่นซ้อน (วิ · เริ่มก่อนเพลงก่อนจบ)" needed ~180px in a
//        105-130px grid cell between sm and lg, wrapped to two lines, and dropped its
//        input 24-31px below its three siblings. jsdom has no layout, so what is pinned
//        is the cause: a label short enough for the cell (it does not carry the long
//        phrase) and the explanation moved onto the field's title. The geometry itself
//        (all four inputs on one top, ±1px, at 768/820/844/1024/1280) needs a real
//        browser.
// CQ-50  Icon-only row buttons, the kind select and the number fields had no accessible
//        name (16 unnamed controls per row on a 16-row set), and the Labels were not
//        bound to their fields.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { makeSession, makeSupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import type { SetlistItem } from "@/lib/types";

const row = (id: string, sort: number, title: string, kind: SetlistItem["kind"] = "song"): SetlistItem => ({
  id,
  event_id: "e1",
  tenant_id: "t1",
  kind,
  title,
  sort_order: sort,
  duration_seconds: 120,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
});

const THREE = [row("s1", 1, "เพลงหนึ่ง"), row("s2", 2, "เพลงสอง"), row("s3", 3, "MC", "mc")];

beforeEach(() => {
  h.supa = makeSupabaseFake({ session: makeSession() });
});

function mount(items: SetlistItem[], editable = true, hardOut: string | null = "16:15:00") {
  return render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId="e1"
        tenantId="t1"
        editable={editable}
        initialItems={items}
        showStartTime="13:00:00"
        hardOutTime={hardOut}
        members={[]}
        songs={[]}
        eventName="Test show"
      />
    </ConfirmProvider>
  );
}

describe("SetlistBuilder · an empty set is not 'in time' (CQ-26)", () => {
  it("says nothing about being on time when there is no row, though a hard out is set", () => {
    mount([]);
    expect(screen.queryByText(/อยู่ในเวลา/)).toBeNull();
    expect(screen.queryByText(/ก่อน Hard Out/)).toBeNull();
    // the slot itself is still shown (0:00 / 3:15:00) and the empty-list text stands
    expect(screen.getByText("/ 3:15:00")).toBeInTheDocument();
    expect(screen.getByText("ยังไม่มีรายการในเซ็ตลิสต์")).toBeInTheDocument();
  });

  it("is empty-silent for a member's read-only view too", () => {
    mount([], false);
    expect(screen.queryByText(/อยู่ในเวลา/)).toBeNull();
  });

  it("still says it, with the time left, once the set has a row that fits", () => {
    mount(THREE);
    // 13:00 + 6:00 of rows against a 16:15 hard out = 3:09:00 left
    expect(screen.getByText(/อยู่ในเวลา/)).toBeInTheDocument();
    expect(screen.getByText("3:09:00")).toBeInTheDocument();
  });

  it("the alarm is unchanged: a set past the hard out still says so", () => {
    mount(THREE, true, "13:05:00");
    expect(screen.getByText(/เกิน Hard Out \+/)).toBeInTheDocument();
    expect(screen.queryByText(/อยู่ในเวลา/)).toBeNull();
  });
});

describe("SetlistBuilder · the overlap label fits its cell (CQ-42)", () => {
  it("is short, and the long phrase no longer sits in the label", () => {
    mount(THREE);
    const labels = screen.getAllByText("เล่นซ้อน (วิ)");
    expect(labels).toHaveLength(THREE.length);
    expect(screen.queryByText(/เริ่มก่อนเพลงก่อนจบ/)).toBeNull();
  });

  it("the explanation moved to the field, as its title", () => {
    mount(THREE);
    const field = screen.getAllByLabelText("เล่นซ้อน (วิ)")[0];
    expect(field).toHaveAttribute("title", expect.stringContaining("เริ่มก่อนเพลงก่อนหน้าจบ"));
  });
});

describe("SetlistBuilder · every row control has a name (CQ-50)", () => {
  it("names the four icon buttons and the kind select on EVERY row", () => {
    mount(THREE);
    const n = THREE.length;
    expect(screen.getAllByRole("button", { name: "เลื่อนขึ้น" })).toHaveLength(n);
    expect(screen.getAllByRole("button", { name: "เลื่อนลง" })).toHaveLength(n);
    expect(screen.getAllByRole("button", { name: "ก๊อปรายการนี้" })).toHaveLength(n);
    expect(screen.getAllByRole("button", { name: "ลบรายการนี้" })).toHaveLength(n);
    expect(screen.getAllByRole("combobox", { name: "ประเภทรายการ" })).toHaveLength(n);
  });

  it("names the title and notes fields, and no row button is left nameless", () => {
    const { container } = mount(THREE);
    expect(screen.getAllByRole("textbox", { name: "ชื่อเพลง / หัวข้อ" })).toHaveLength(THREE.length);
    // every button on a row has a name from text or aria-label (the page's own add
    // buttons are outside the rows and have text)
    const unnamed = [...container.querySelectorAll("button")].filter(
      (b) => !(b.getAttribute("aria-label") || b.textContent?.trim() || b.getAttribute("title"))
    );
    expect(unnamed).toEqual([]);
  });

  it("binds the length, overlap and buffer labels to their own row's field", () => {
    mount(THREE);
    // the number field is a spinbutton and is found by its visible label
    const buffers = screen.getAllByRole("spinbutton", { name: /เผื่อเวลาหลัง/ });
    expect(buffers).toHaveLength(THREE.length);
    expect(screen.getAllByLabelText(/ความยาว \(m:ss\)/)).toHaveLength(THREE.length);
    expect(screen.getAllByLabelText("เล่นซ้อน (วิ)")).toHaveLength(THREE.length);
    // ids are keyed by the row, so no two rows share one
    const ids = [
      ...buffers.map((b) => b.id),
      ...screen.getAllByLabelText("เล่นซ้อน (วิ)").map((b) => b.id),
      ...screen.getAllByLabelText(/ความยาว \(m:ss\)/).map((b) => b.id),
    ];
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("each row's label reaches THAT row's input", () => {
    mount(THREE);
    const buffers = screen.getAllByRole("spinbutton", { name: /เผื่อเวลาหลัง/ });
    // the three rows' fields sit in three different rows
    const rows = buffers.map((b) => b.closest("[class*='slab']"));
    expect(new Set(rows).size).toBe(THREE.length);
    expect(within(rows[1] as HTMLElement).getByDisplayValue("เพลงสอง")).toBeInTheDocument();
  });
});
