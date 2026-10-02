// Follow-up to CQ-06 (round 15). Since CQ-06 the Mics tab shows the members' own
// standing mic numbers, read-only, whenever the show has no per-event mic rows (40 of
// 41 production events). Per-event rows WIN on every surface the moment one exists —
// the Summary, the Lineup, the readiness gate, the Excel sheet, this tab — so the first
// "เพิ่มไมค์" used to insert ONE empty mic #1 and, from then on, the band's seven mics
// were gone from every surface and one blank mic took their place. The first add now
// seeds the show's own map from what was on screen (one row per standing mic, then the
// new one) in a single all-or-nothing insert that asks for its rows back, so a failed
// or empty-handed write leaves the tab exactly as it was (lib/write-guard.ts: a write
// that touched no row did not happen).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeSession, makeSupabaseFake, ok, fail, offline } from "@/test/fakes/supabase";
import type { SupabaseFake } from "@/test/fakes/supabase";
import type { Member, MicAssignment } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { MicMapEditor } from "@/components/event/mic-map-editor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";

const CAPTION = "ไมค์ประจำตัวสมาชิก (ยังไม่ได้ปรับเฉพาะงานนี้)";
const ADD = /เพิ่มไมค์/;

const member = (n: number, over: Partial<Member> = {}): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});
const three = () => [1, 2, 3].map((n) => member(n));

const assignment = (n: number, name: string): MicAssignment => ({
  id: `a${n}`,
  tenant_id: "t1",
  event_id: "e1",
  mic_number: n,
  holder_name: name,
  order_index: 1,
  created_at: "2026-01-01T00:00:00.000Z",
});

// An insert answers with the rows it was given, each with an id: what PostgREST does
// for `.insert(rows).select("*")` (and for `.single()`, the one row).
const echo = (call: { values: unknown; terminal: string | null }) => {
  const rows = (Array.isArray(call.values) ? call.values : [call.values]) as Record<string, unknown>[];
  const out = rows.map((r, i) => ({ id: `new-${i}`, created_at: "2026-10-02T00:00:00.000Z", ...r }));
  return ok(call.terminal === "single" ? out[0] : out);
};

let supa: SupabaseFake;

function mount(over: { members?: Member[]; lineup?: string[]; initialMics?: MicAssignment[] } = {}) {
  return render(
    <ConfirmProvider>
      <MicMapEditor
        eventId="e1"
        tenantId="t1"
        editable
        initialMics={over.initialMics ?? []}
        members={over.members ?? three()}
        lineup={over.lineup ?? []}
        setlist={[]}
        eventName="งานทดสอบ"
      />
    </ConfirmProvider>
  );
}

const inserts = () => supa.callsTo("mic_assignments", "insert");
const micInputs = () =>
  screen.queryAllByRole("spinbutton").map((el) => Number((el as HTMLInputElement).value));
const standingTiles = (c: HTMLElement) => c.querySelectorAll(".mic");

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession(), script: { mic_assignments: echo } });
  h.supa = supa;
  toast.success.mockClear();
  toast.error.mockClear();
  toast.info.mockClear();
});
afterEach(() => {
  registerMgmtQueueSink(null); // module-level state — never leak it to the next test
  document.body.innerHTML = "";
});

describe("MicMapEditor · the first add seeds the show's map from the standing mics", () => {
  it("keeps the band's mics and adds the new one after them, in ONE insert", async () => {
    const { container } = mount();
    expect(standingTiles(container)).toHaveLength(3);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 2, 3, 4]));

    expect(inserts()).toHaveLength(1);
    const call = inserts()[0];
    expect(call.selectAfterWrite).toBe(true); // the write asks for its rows back
    expect(call.values).toEqual([
      { tenant_id: "t1", event_id: "e1", mic_number: 1, holder_name: "นิค1", order_index: 1 },
      { tenant_id: "t1", event_id: "e1", mic_number: 2, holder_name: "นิค2", order_index: 1 },
      { tenant_id: "t1", event_id: "e1", mic_number: 3, holder_name: "นิค3", order_index: 1 },
      { tenant_id: "t1", event_id: "e1", mic_number: 4, holder_name: "", order_index: 1 },
    ]);

    // the show's own map has taken over: the standing tiles and their caption are gone,
    // and the names the members had are the holders, not blanks
    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(standingTiles(container)).toHaveLength(0);
    expect(screen.getAllByPlaceholderText("ชื่อสมาชิก").map((el) => (el as HTMLInputElement).value)).toEqual([
      "นิค1",
      "นิค2",
      "นิค3",
      "",
    ]);
  });

  it("seeds only the people in this show's lineup", async () => {
    mount({ members: [1, 2, 3, 4, 5].map((n) => member(n)), lineup: ["m2", "m5"] });
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([2, 5, 6]));
    expect((inserts()[0].values as { mic_number: number }[]).map((r) => r.mic_number)).toEqual([2, 5, 6]);
  });

  // The lineup the editor is handed is the page's LIVE one (EventWorkspace keeps it
  // current as the Lineup tab is edited), so it changes while this editor stays
  // mounted — and what the first add seeds must be the tiles on screen NOW, not the
  // ones it mounted with. (event-workspace.lineup-live.test.tsx walks the whole path.)
  it("seeds the tiles on screen now when the lineup it is handed changes under it", async () => {
    const tree = (lineup: string[]) => (
      <ConfirmProvider>
        <MicMapEditor
          eventId="e1"
          tenantId="t1"
          editable
          initialMics={[]}
          members={three()}
          lineup={lineup}
          setlist={[]}
          eventName="งานทดสอบ"
        />
      </ConfirmProvider>
    );
    const { container, rerender } = render(tree(["m1", "m2", "m3"]));
    expect(standingTiles(container)).toHaveLength(3);

    rerender(tree(["m1", "m3"])); // m2 taken off the lineup elsewhere on the page
    expect(standingTiles(container)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 3, 4]));
    expect(
      (inserts()[0].values as { mic_number: number; holder_name: string }[]).map((r) => [
        r.mic_number,
        r.holder_name,
      ])
    ).toEqual([
      [1, "นิค1"],
      [3, "นิค3"],
      [4, ""],
    ]);
  });

  it("keeps a shared mic as ONE mic with its holders in rotation order", async () => {
    mount({ members: [member(1), member(2, { mic_number: 1 }), member(3)] });
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 3, 4]));
    expect(
      (inserts()[0].values as { mic_number: number; holder_name: string; order_index: number }[]).map(
        (r) => [r.mic_number, r.holder_name, r.order_index]
      )
    ).toEqual([
      [1, "นิค1", 1],
      [1, "นิค2", 2],
      [3, "นิค3", 1],
      [4, "", 1],
    ]);
    expect(screen.getByText("วนไมค์ 2 คน")).toBeInTheDocument();
  });

  it("numbers the new mic after the highest standing mic, not after the count", async () => {
    mount({ members: [member(1, { mic_number: 5 }), member(2, { mic_number: 9 })] });
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([5, 9, 10]));
  });

  it("a later add is a plain one-row insert: the map is the show's own now", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 2, 3, 4]));
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 2, 3, 4, 5]));
    expect(inserts()).toHaveLength(2);
    expect(inserts()[1].values).toEqual({
      tenant_id: "t1",
      event_id: "e1",
      mic_number: 5,
      holder_name: "",
      order_index: 1,
    });
  });
});

describe("MicMapEditor · the paths that must not change", () => {
  it("a show that already has its own mics adds one row after them, seeding nothing", async () => {
    mount({ initialMics: [assignment(1, "นิค1"), assignment(7, "แขก")] });
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 7, 8]));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values).toEqual({
      tenant_id: "t1",
      event_id: "e1",
      mic_number: 8,
      holder_name: "",
      order_index: 1,
    });
  });

  it("with no standing mics at all, the first add is mic #1 and nothing else", async () => {
    mount({ members: [1, 2].map((n) => member(n, { mic_number: null })) });
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1]));
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].values).toEqual({
      tenant_id: "t1",
      event_id: "e1",
      mic_number: 1,
      holder_name: "",
      order_index: 1,
    });
  });
});

describe("MicMapEditor · a write that did not happen leaves the standing mics showing", () => {
  it("a rejected insert: an error, the standing tiles still there, no rows invented", async () => {
    supa.setTable("mic_assignments", fail({ message: "permission denied", code: "42501" }, 403));
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("เพิ่มไมค์ไม่สำเร็จ", { description: "permission denied" })
    );
    expect(micInputs()).toEqual([]);
    expect(standingTiles(container)).toHaveLength(3);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    // and the button is live again: a retry is possible
    await waitFor(() => expect(screen.getByRole("button", { name: ADD })).toBeEnabled());
  });

  it("an insert that reports no error but returns no row is NOT a success", async () => {
    // RLS answers an anon request with 200 and [] (lib/write-guard.ts)
    supa.setTable("mic_assignments", ok([]));
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ยังไม่ได้บันทึก", expect.anything()));
    expect(toast.error.mock.calls[0][1].description).toMatch(/โหลดหน้าใหม่|เข้าสู่ระบบใหม่/);
    expect(micInputs()).toEqual([]);
    expect(standingTiles(container)).toHaveLength(3);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ADD })).toBeEnabled();
  });

  it("a retry after a failure seeds again from the same standing mics", async () => {
    supa.setTable("mic_assignments", [fail("boom"), echo]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: ADD })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 2, 3, 4]));
    expect(inserts()).toHaveLength(2);
    expect((inserts()[1].values as unknown[]).length).toBe(4);
  });

  it("offline on the desktop: the whole seeded map is queued as ONE snapshot and kept on screen", async () => {
    const sink = vi.fn<(op: unknown) => Promise<void>>(async () => {});
    registerMgmtQueueSink(sink);
    supa.setTable("mic_assignments", offline());
    mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 2, 3, 4]));
    expect(sink).toHaveBeenCalledTimes(1);
    const op = sink.mock.calls[0][0] as { kind: string; rows: unknown[] };
    expect(op.kind).toBe("mic.upsert");
    expect(op.rows).toHaveLength(4);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
