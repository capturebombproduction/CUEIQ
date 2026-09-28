// "ให้ … เติมให้พอดี" up by the run-time badge. The fill itself is the old
// "เวลาที่เหลือ" (it lived only on the last row); what is pinned here is that the
// button appears exactly when the set does NOT fit, names the row it will change,
// and writes that row's new length. Measured 2026-09-28: 12 of 25 Seishin Kakumei
// shows ended 18–34 s short or over — copied from a show that fitted, a song
// swapped, the last-row button never pressed again.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-2222-4222-8222-tttttttttttt";

const row = (id: string, sort: number, title: string, kind: SetlistItem["kind"], dur: number): SetlistItem => ({
  id,
  event_id: EVENT_ID,
  tenant_id: TENANT_ID,
  kind,
  title,
  sort_order: sort,
  duration_seconds: dur,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
  song_id: null,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
});

// A 13:00–13:20 slot. Four songs + MC = 1082 s; ถ่ายรูป carried over at 100 s
// from the show it was copied from → 1182, 18 s short — the exact real case.
const set = (photo: number) => [
  row("s1", 1, "[SYSTEM_BOOT] SE", "song", 96),
  row("s2", 2, "I Am Who I Am", "song", 235),
  row("s3", 3, "Flash of Rebellion", "song", 257),
  row("s4", 4, "Overclock Strike", "song", 239),
  row("mc", 5, "MC", "mc", 255),
  row("photo", 6, "ถ่ายรูป", "mc", photo),
];

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setScript({
    setlist_items: (call) => (call.verb === "update" ? ok([{ id: "photo" }]) : ok([])),
  });
});

const mount = (items: SetlistItem[]) =>
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={items}
        showStartTime="13:00:00"
        hardOutTime="13:20:00"
        members={[]}
        songs={[]}
        eventName="Test show"
      />
    </ConfirmProvider>
  );

const fillButton = () => screen.queryByRole("button", { name: /ให้ “ถ่ายรูป” เติมให้พอดี/ });

describe("SetlistBuilder — fill-to-fit beside the run-time badge", () => {
  it("offers to fill when the set is short, and writes the closing row's new length", async () => {
    mount(set(100));
    const btn = fillButton();
    expect(btn).toBeTruthy();
    await act(async () => {
      fireEvent.click(btn!);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(1));
    const call = supa.callsTo("setlist_items", "update")[0];
    expect(call.values).toEqual({ duration_seconds: 118 }); // 100 + the 18 s gap
    expect(call.filters).toContainEqual(expect.objectContaining({ column: "id", value: "photo" }));
  });

  it("also trims the closing row when the set runs over", async () => {
    mount(set(130)); // 1212 s → 12 s over
    await act(async () => {
      fireEvent.click(fillButton()!);
    });
    await waitFor(() => expect(supa.callsTo("setlist_items", "update")).toHaveLength(1));
    expect(supa.callsTo("setlist_items", "update")[0].values).toEqual({ duration_seconds: 118 });
  });

  it("is not there when the set already fits to the second", () => {
    mount(set(118));
    expect(fillButton()).toBeNull();
  });
});

// Phone layout (2026-09-28): "เล่นซ้อน" / "เผื่อเวลาหลัง" fold behind one button
// when a row uses neither (3% / 2% of real rows). Pinned: a row that DOES use one
// is never folded. The look was checked in a real browser at 390px.
describe("SetlistBuilder — folding the timing tweaks on a phone", () => {
  const overlapBoxes = () =>
    screen.getAllByText("เล่นซ้อน (วิ · เริ่มก่อนเพลงก่อนจบ)").map((l) => l.closest("div.space-y-1")!);
  const isFolded = (el: Element) => el.className.split(" ").includes("hidden");

  it("keeps them open on a row that uses them, folds them on one that does not", () => {
    const items = set(118);
    items[0] = { ...items[0], buffer_after_seconds: 5 };
    mount(items);
    const boxes = overlapBoxes();
    expect(isFolded(boxes[0])).toBe(false); // row 1 has a 5 s buffer
    expect(isFolded(boxes[1])).toBe(true); // row 2 uses neither
  });
});
