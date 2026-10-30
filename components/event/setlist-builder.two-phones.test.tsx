// 2026-10-30, hunt 12. Two phones on the Setlist tab held their own list for as long as they
// stayed there: the panel read the rows once, at mount, and listened only to the show's state.
// A tap on a title or a length, with no typing, wrote this screen's old copy over the other's
// save (Live's AUTO then cut on the old length), and a stale ▲▼ made ties nobody saw. And in
// Manual the lock sat on the CUED row, leaving the row really sounding open to a swap or delete.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";

function item(n: number, over: Partial<SetlistItem> = {}): SetlistItem {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title: `Track ${n}`,
    sort_order: n,
    duration_seconds: 200,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
    ...over,
  };
}
const A = item(1);
const B = item(2);

let supa: SupabaseFake;
let server: SetlistItem[];
let updateAnswer: (c: RecordedCall) => unknown;
const live = () => supa.channelFor(liveTopic(EVENT_ID))!;
const titles = () => screen.getAllByLabelText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[];
const updates = () => supa.callsTo("setlist_items", "update");
const reads = () => supa.callsTo("setlist_items", "select");
const saidChanged = async () => {
  await act(async () => {
    live().emit("setlist-changed", { at: Date.now() });
  });
};
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

beforeEach(() => {
  vi.clearAllMocks();
  server = [A, B];
  updateAnswer = (c) => ok([{ id: c.eq.id }]);
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      setlist_versions: ok([]),
      setlist_items: ((c: RecordedCall) => (c.verb === "update" ? updateAnswer(c) : ok(server))) as never,
    },
  });
  h.supa = supa;
});
afterEach(cleanup);

function mount() {
  return render(
    <ConfirmProvider>
      <SetlistBuilder eventId={EVENT_ID} tenantId={TENANT_ID} editable initialItems={[A, B]}
        showStartTime="19:00" hardOutTime={null} members={[]} songs={[]} eventName="Show" />
    </ConfirmProvider>
  );
}

describe("SetlistBuilder: leaving a field with nothing changed", () => {
  it("a title touched and left writes nothing", async () => {
    mount();
    await act(async () => {
      fireEvent.focus(titles()[0]);
      fireEvent.blur(titles()[0]);
    });
    expect(updates()).toHaveLength(0);
  });

  it("a length touched and left writes nothing", async () => {
    mount();
    const dur = document.getElementById(`sl-${A.id}-dur`) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(dur);
      fireEvent.blur(dur);
    });
    expect(updates()).toHaveLength(0);
  });

  it("a real edit still saves", async () => {
    mount();
    await act(async () => {
      fireEvent.change(titles()[0], { target: { value: "Renamed" } });
      fireEvent.blur(titles()[0]);
    });
    expect(updates()).toHaveLength(1);
    expect(updates()[0].values).toEqual({ title: "Renamed" });
  });

  it("a save that failed is retried by leaving the field again", async () => {
    updateAnswer = () => fail("boom");
    mount();
    await act(async () => {
      fireEvent.change(titles()[0], { target: { value: "Renamed" } });
      fireEvent.blur(titles()[0]);
    });
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    updateAnswer = (c) => ok([{ id: c.eq.id }]);
    await act(async () => {
      fireEvent.focus(titles()[0]);
      fireEvent.blur(titles()[0]);
    });
    expect(updates()).toHaveLength(2);
  });

  it("going back to the old value while the first save is still out writes it too", async () => {
    let answer: (v: unknown) => void = () => {};
    updateAnswer = () => new Promise((r) => (answer = r));
    mount();
    await act(async () => {
      fireEvent.change(titles()[0], { target: { value: "Renamed" } });
      fireEvent.blur(titles()[0]);
    });
    await act(async () => {
      fireEvent.change(titles()[0], { target: { value: A.title } });
      fireEvent.blur(titles()[0]);
    });
    await waitFor(() => expect(updates()).toHaveLength(2));
    await act(async () => answer(ok([{ id: A.id }])));
  });
});

describe("SetlistBuilder: another phone's save reaches the tab on screen", () => {
  it("re-reads on setlist-changed and shows the other phone's rows, in their order", async () => {
    mount();
    server = [item(2, { sort_order: 1 }), item(1, { sort_order: 2, title: "Their name" })];
    await saidChanged();
    await waitFor(() => expect(titles().map((t) => t.value)).toEqual(["Track 2", "Their name"]));
  });

  it("a burst of saves is one read", async () => {
    mount();
    const before = reads().length;
    await saidChanged();
    await saidChanged();
    await saidChanged();
    await wait(700);
    expect(reads().length).toBe(before + 1);
  });

  it("a row deleted on the other phone goes", async () => {
    mount();
    server = [B];
    await saidChanged();
    await waitFor(() => expect(titles()).toHaveLength(1));
    expect(titles()[0].value).toBe(B.title);
  });

  it("after the read, a touched field does not put the old value back", async () => {
    mount();
    server = [{ ...A, title: "Their name" }, B];
    await saidChanged();
    await waitFor(() => expect(titles()[0].value).toBe("Their name"));
    await act(async () => {
      fireEvent.focus(titles()[0]);
      fireEvent.blur(titles()[0]);
    });
    expect(updates()).toHaveLength(0);
  });

  it("waits while a field is in use, keeps what is being typed, and comes in after", async () => {
    mount();
    titles()[0].focus();
    fireEvent.change(titles()[0], { target: { value: "Half typed" } });
    server = [A, { ...B, title: "Their name" }];
    const before = reads().length;
    await saidChanged();
    await wait(700);
    expect(reads().length).toBe(before); // not even read yet
    expect(titles()[0].value).toBe("Half typed");
    server = [{ ...A, title: "Half typed" }, { ...B, title: "Their name" }];
    await act(async () => {
      titles()[0].blur(); // its save goes out, and the read waits for that too
    });
    await waitFor(() => expect(titles()[1].value).toBe("Their name"), { timeout: 3000 });
    expect(titles()[0].value).toBe("Half typed");
    expect(updates()).toHaveLength(1);
  });

  it("an edit that failed to save stays on screen over the read", async () => {
    updateAnswer = () => fail("boom");
    mount();
    await act(async () => {
      fireEvent.change(titles()[0], { target: { value: "Mine, unsaved" } });
      fireEvent.blur(titles()[0]);
    });
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    server = [A, { ...B, title: "Their name" }];
    await saidChanged();
    await waitFor(() => expect(titles()[1].value).toBe("Their name"), { timeout: 3000 });
    expect(titles()[0].value).toBe("Mine, unsaved");
  });

  it("does not lay a read over a write of this device's that is still out", async () => {
    let answer: (v: unknown) => void = () => {};
    updateAnswer = () => new Promise((r) => (answer = r));
    mount();
    await act(async () => {
      fireEvent.change(titles()[0], { target: { value: "Renamed" } });
      fireEvent.blur(titles()[0]);
    });
    await waitFor(() => expect(updates()).toHaveLength(1));
    const before = reads().length;
    await saidChanged();
    await wait(700);
    expect(reads().length).toBe(before);
    expect(titles()[0].value).toBe("Renamed");
    server = [{ ...A, title: "Renamed" }, B];
    await act(async () => answer(ok([{ id: A.id }])));
    await waitFor(() => expect(reads().length).toBeGreaterThan(before), { timeout: 3000 });
    expect(titles()[0].value).toBe("Renamed");
  });

  it("an empty answer with no session behind it does not blank the list", async () => {
    mount();
    supa.auth.setSession(null);
    server = [];
    await saidChanged();
    await wait(700);
    expect(titles()).toHaveLength(2);
  });

  it("back on the channel after a blip it re-reads; the first join does not", async () => {
    mount();
    const before = reads().length;
    await act(async () => live().setStatus("SUBSCRIBED"));
    await wait(700);
    expect(reads().length).toBe(before);
    server = [{ ...A, title: "Said in the blip" }, B];
    await act(async () => live().setStatus("SUBSCRIBED"));
    await waitFor(() => expect(titles()[0].value).toBe("Said in the blip"));
  });
});

describe("SetlistBuilder: the on-air lock covers what really sounds", () => {
  const manual = { begun: true, ended: false, running: false, currentItemId: B.id };
  const emit = async (p: Record<string, unknown>) => {
    await act(async () => {
      live().emit("state", p);
    });
  };

  it("in Manual both the cued row and the sounding row are locked", async () => {
    mount();
    await emit({ ...manual, audioItemId: A.id, audioPlaying: true });
    expect(titles()[0].disabled).toBe(true);
    expect(titles()[1].disabled).toBe(true);
  });

  it("a pad sounding under NOW is locked", async () => {
    mount();
    await emit({ ...manual, audioItemId: B.id, audioPlaying: false, pads: { ended: null, layers: [{ id: A.id }] } });
    expect(titles()[0].disabled).toBe(true);
  });

  it("a committed row whose sound is over locks nothing", async () => {
    mount();
    await emit({ ...manual, audioItemId: A.id, audioPlaying: true, pads: { ended: A.id, layers: [] } });
    expect(titles()[0].disabled).toBe(false);
  });

  it("the row that started sounding while the delete's sheet was open is refused", async () => {
    mount();
    fireEvent.click(screen.getAllByLabelText("ลบรายการนี้")[0]);
    const go = await screen.findByRole("button", { name: "ลบ" });
    await emit({ ...manual, audioItemId: A.id, audioPlaying: true });
    await act(async () => {
      fireEvent.click(go);
    });
    expect(toastSpy.error).toHaveBeenCalledWith("แถวนี้กำลังเล่นอยู่บนเวที — ยังลบไม่ได้");
    expect(supa.callsTo("setlist_items", "delete")).toHaveLength(0);
  });

  it("after จบโชว์ nothing stays locked", async () => {
    mount();
    await emit({ ...manual, audioItemId: A.id, audioPlaying: true });
    await emit({ ...manual, ended: true, audioItemId: A.id, audioPlaying: true, pads: { layers: [{ id: A.id }] } });
    expect(titles()[0].disabled).toBe(false);
    expect(titles()[1].disabled).toBe(false);
  });
});
