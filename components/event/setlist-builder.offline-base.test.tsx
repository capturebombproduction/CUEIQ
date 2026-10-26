// The base an offline setlist edit is queued against must be the list the SERVER holds.
//
// The title, "เข้าหลังเพลงก่อนหน้า" and note fields setLocal on every keystroke and persist
// on blur, from a render whose `items` already holds the typed value. The snapshot used
// to be queued with `baseRows: items`, so base == rows: on replay the online-wins guard
// (lib/mgmt-outbox.ts childFlushDecision) saw "server ≠ my rows, server ≠ my base" and
// parked the venue's own edit as "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" although
// nobody had touched the online copy - and planEnqueue keeps that first base, so every
// later offline edit of the night parked with it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  offline,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";

function item(id: string, sort_order: number, title: string): SetlistItem {
  return {
    id,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title,
    sort_order,
    duration_seconds: 200,
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

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
/** What the server holds - and what the desktop loaded before the wifi died. */
let server: SetlistItem[];
let netDown = false;

/** A tiny stateful setlist_items table: updates land while the net is up. */
function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb === "update") {
    const r = server.find((x) => x.id === call.eq.id);
    if (!r) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  }
  return ok(server.map((r) => ({ ...r })));
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [item(A, 1, "Opener"), item(B, 2, "Closer")];
  netDown = false;
  supa.setTable("setlist_items", table);
  queued = [];
  registerMgmtQueueSink(async (op) => {
    queued.push(op);
  });
});
afterEach(() => {
  registerMgmtQueueSink(null);
  cleanup();
});

function mount() {
  return render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={server.map((r) => ({ ...r }))}
        showStartTime="19:00"
        hardOutTime={null}
        members={[]}
        songs={[]}
        eventName="Show"
      />
    </ConfirmProvider>
  );
}

async function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}

const titles = () => screen.getAllByRole("textbox", { name: "ชื่อเพลง / หัวข้อ" });
const notes = () => screen.getAllByRole("textbox", { name: "โน้ต" });

describe("setlist builder: the base an offline edit is queued against", () => {
  it("a title typed offline replays as 'apply' against an untouched server", async () => {
    netDown = true;
    mount();
    await type(titles()[0], "Opener (acoustic)");
    expect(queued, "the offline edit reached the outbox").toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("a note typed offline replays as 'apply' against an untouched server", async () => {
    netDown = true;
    mount();
    await type(notes()[1], "เปลี่ยนชุด");
    expect(queued).toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("a 'เข้าหลังเพลงก่อนหน้า' typed offline replays as 'apply' against an untouched server", async () => {
    netDown = true;
    const { container } = mount();
    await type(container.querySelector<HTMLInputElement>(`#sl-${B}-overlap`)!, "-5");
    expect(queued).toHaveLength(1);
    const op = queued[0] as ChildListOp;
    expect((op.rows as SetlistItem[]).find((r) => r.id === B)!.buffer_before_seconds).toBe(-5);
    expect(childFlushDecision(op, server)).toBe("apply");
  });

  it("a note saved online goes up trimmed; a later offline edit is based on what was written", async () => {
    mount();
    await type(notes()[0], "  โปรย confetti  ");
    expect(server[0].notes, "saved trimmed").toBe("โปรย confetti");
    // the field keeps what was typed - the base must not
    expect((notes()[0] as HTMLInputElement).value).toBe("  โปรย confetti  ");

    netDown = true;
    await type(titles()[1], "Closer (encore)");
    expect(queued).toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("after a queued edit has landed, the next offline edit is based on the list that landed", async () => {
    netDown = true;
    mount();
    await type(titles()[0], "Opener (acoustic)");
    expect(queued).toHaveLength(1);
    // the flush lands that snapshot: the server now holds exactly its rows
    server = (queued[0] as ChildListOp).rows.map((r) => ({ ...(r as SetlistItem) }));

    await type(notes()[1], "เปลี่ยนชุด");
    expect(queued).toHaveLength(2);
    expect(childFlushDecision(queued[1] as ChildListOp, server)).toBe("apply");
  });
});
