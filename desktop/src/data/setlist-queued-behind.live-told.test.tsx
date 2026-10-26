// A setlist edit that lands from the desktop queue tells a running Live Mode
// (2026-10-27 desktop hunt; a regression of c4388cf's queue-behind).
//
// While a setlist snapshot waits in the desktop queue, an edit made ONLINE joins that
// snapshot instead of writing to the server - and returns before the builder's
// notifyLive(). The flush that later lands it (mgmt-outbox.ts applyChildListOp) sent
// nothing on the show channel either. Before c4388cf the same online edit wrote straight
// to the server and sent "setlist-changed", so a running Live Mode on the PA (another
// device) re-read it at once; afterwards it kept the old length (AUTO cuts on it) / the
// old song until something else made it re-read. A landed setlist snapshot now sends
// "setlist-changed" on the show's channel - on the builder's own channel when one is open,
// on a channel of its own (opened, used, removed) when none is.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  makeSession,
  makeSupabaseFake,
  ok,
  offline,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  Toaster: () => null,
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { registerMgmtQueueSink, registerQueuedChildListReader } from "@/lib/mgmt-write";
import { fingerprintChildRows, MGMT_CHILD_LANDED_EVENT } from "@/lib/mgmt-outbox";
import { liveTopic } from "@/lib/realtime";
import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  pendingMgmtOps,
} from "~/data/mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "cccccccc-3333-4333-8333-cccccccccccc";

function item(id: string, sort_order: number, title: string, duration: number): SetlistItem {
  return {
    id,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title,
    sort_order,
    duration_seconds: duration,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
  };
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";

let supa: SupabaseFake;
let server: SetlistItem[];
let netDown = false;

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb === "select") return ok(server.map((r) => ({ ...r })));
  if (call.verb === "update") {
    const r = server.find((x) => x.id === call.eq.id);
    if (!r) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  }
  if (call.verb === "upsert") {
    for (const v of call.values as SetlistItem[]) {
      const at = server.findIndex((x) => x.id === v.id);
      if (at >= 0) server[at] = { ...server[at], ...v };
      else server.push({ ...v });
    }
    return ok(null);
  }
  if (call.verb === "delete") {
    const keep = call.filters.find((f) => f.op === "not" && f.column === "id");
    const ids = keep ? String(keep.value).replace(/[()]/g, "").split(",") : [];
    server = server.filter((x) => ids.includes(x.id));
    return ok([]);
  }
  return ok([]);
}

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setTable("setlist_items", table);
  server = [item(A, 1, "Song A", 200), item(B, 2, "Song B", 200)];
  netDown = false;
  await clearMgmtOutbox();
  registerMgmtQueueSink(enqueueMgmtOp);
  registerQueuedChildListReader(async (kind, eventId) =>
    (await pendingMgmtOps()).some((op) => op.kind === kind && op.id === eventId)
  );
});
afterEach(() => {
  registerMgmtQueueSink(null);
  registerQueuedChildListReader(null);
});

describe("a queued setlist edit that lands reaches a running Live Mode", () => {
  it("an online edit that joined a queued snapshot: Live is told once it is on the server", async () => {
    const { container } = render(
      <ConfirmProvider>
        <SetlistBuilder
          eventId={EVENT_ID}
          tenantId={TENANT_ID}
          editable
          initialItems={server.map((r) => ({ ...r }))}
          showStartTime={null}
          hardOutTime={null}
          members={[]}
          songs={[]}
          eventName="Seishin @ Venue"
        />
      </ConfirmProvider>
    );
    const live = supa.channelFor(liveTopic(EVENT_ID))!;

    // 1. venue wifi blip: song A's title edit is queued offline
    netDown = true;
    const titles = screen.getAllByLabelText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[];
    fireEvent.change(titles[0], { target: { value: "Song A (acoustic)" } });
    await act(async () => {
      fireEvent.blur(titles[0]);
    });
    await waitFor(async () => expect(await pendingMgmtOps()).toHaveLength(1));

    // 2. the net is back (the PA's Live Mode runs on another device); before the 30 s
    //    re-arm flushes, the Ar shortens song B to 2:30 - Live's AUTO cuts on it
    netDown = false;
    const durB = container.querySelector<HTMLInputElement>(`#sl-${B}-dur`)!;
    fireEvent.change(durB, { target: { value: "2:30" } });
    await act(async () => {
      fireEvent.blur(durB);
    });
    await waitFor(async () => expect(await pendingMgmtOps()).toHaveLength(1));
    expect(live.sent.map((s) => s.event)).not.toContain("setlist-changed"); // joined the queue

    // 3. the flush lands both edits on the server…
    const res = await flushMgmtOutbox();
    expect(res).toMatchObject({ flushed: 1, parked: 0 });
    expect(server.find((r) => r.id === B)!.duration_seconds).toBe(150);

    // …and a running Live Mode is asked to re-read, on the channel the builder holds
    expect(live.sent.map((s) => s.event)).toContain("setlist-changed");
    expect(live.removed).toBe(false);
  });

  it("with no screen holding the show's channel, it opens one, sends, and lets it go", async () => {
    const rows = [{ ...server[0], title: "Song A (acoustic)" }, server[1]];
    await enqueueMgmtOp({
      kind: "setlist.upsert",
      id: EVENT_ID,
      tenantId: TENANT_ID,
      eventName: "Seishin @ Venue",
      rows,
      base: fingerprintChildRows("setlist.upsert", server),
    });

    expect(await flushMgmtOutbox()).toMatchObject({ flushed: 1, parked: 0 });
    const ch = supa.channelFor(liveTopic(EVENT_ID))!;
    expect(ch).toBeTruthy();
    expect(ch.sent).toHaveLength(0); // not before the join
    vi.useFakeTimers();
    try {
      ch.setStatus("SUBSCRIBED");
      expect(ch.sent.map((s) => s.event)).toEqual(["setlist-changed"]);
      vi.advanceTimersByTime(1000);
      expect(ch.removed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A client never hears its own broadcast (lib/realtime.ts self: false): a Live Mode open on
  // THIS desktop - the PA laptop whose queued edit this was - is told through the window.
  it("a Live Mode on this same desktop is told through the window", async () => {
    const heard: unknown[] = [];
    const onLanded = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(MGMT_CHILD_LANDED_EVENT, onLanded);
    try {
      await enqueueMgmtOp({
        kind: "setlist.upsert",
        id: EVENT_ID,
        tenantId: TENANT_ID,
        eventName: "Seishin @ Venue",
        rows: [{ ...server[0], title: "Song A (acoustic)" }, server[1]],
        base: fingerprintChildRows("setlist.upsert", server),
      });
      expect(heard).toEqual([]); // queued is not landed
      expect(await flushMgmtOutbox()).toMatchObject({ flushed: 1, parked: 0 });
      expect(heard).toEqual([{ eventId: EVENT_ID, kind: "setlist.upsert" }]);
    } finally {
      window.removeEventListener(MGMT_CHILD_LANDED_EVENT, onLanded);
    }
  });

  it("control: a landed schedule snapshot is not a setlist change", async () => {
    await enqueueMgmtOp({
      kind: "schedule.upsert",
      id: EVENT_ID,
      tenantId: TENANT_ID,
      eventName: "Seishin @ Venue",
      rows: [],
      base: fingerprintChildRows("schedule.upsert", []),
    });
    supa.setTable("schedule_items", ok([]));

    expect(await flushMgmtOutbox()).toMatchObject({ flushed: 1, parked: 0 });

    expect(supa.channelFor(liveTopic(EVENT_ID))).toBeUndefined();
  });
});
