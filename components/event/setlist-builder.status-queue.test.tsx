// On the desktop, a setlist edit that a SICK server refuses - a Supabase/Cloudflare
// 503 / 502 / 429, the server up and answering badly - must be queued like any other
// transient failure. Round 10 taught isQueueableWriteError (lib/mgmt-outbox.ts) to take
// the HTTP status for exactly this, but tryQueueChildList had no status parameter and
// the builder only destructured { data, error }: the 503 arrives as an HTML page in
// error.message, matches none of the network words, and was classed a REAL REJECTION -
// toast "บันทึกไม่สำเร็จ", nothing queued, the edit on screen only.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import type { ChildListOp, NewMgmtOp } from "@/lib/mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";

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

const ROWS = [
  item("aaaaaaaa-0000-4000-8000-000000000001", 1, "Opener"),
  item("aaaaaaaa-0000-4000-8000-000000000002", 2, "Closer"),
];
const PAGE_503 = "<html><body><h1>503 Service Unavailable</h1></body></html>";

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
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
  render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={ROWS.map((r) => ({ ...r }))}
        showStartTime="19:00"
        hardOutTime={null}
        members={[]}
        songs={[]}
        eventName="Show"
      />
    </ConfirmProvider>
  );
}

async function retitle(value: string) {
  const title = screen.getAllByRole("textbox", { name: "ชื่อเพลง / หัวข้อ" })[0];
  fireEvent.change(title, { target: { value } });
  await act(async () => {
    fireEvent.blur(title);
  });
}

describe("desktop setlist edit vs a server that is up and answering badly", () => {
  it("a 503 on a title edit is queued for replay", async () => {
    supa.setScript({ setlist_items: fail(PAGE_503, 503) });
    mount();
    await retitle("Opener (acoustic)");
    expect(queued).toHaveLength(1);
    expect(((queued[0] as ChildListOp).rows as SetlistItem[])[0].title).toBe("Opener (acoustic)");
  });

  it("a 429 on a ▲/▼ swap is queued for replay", async () => {
    supa.setScript({ setlist_items: fail("Too Many Requests", 429) });
    mount();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนลง" })[0]);
    });
    await waitFor(() => expect(queued).toHaveLength(1));
  });

  it("a 403 is still a real rejection - never queued", async () => {
    supa.setScript({ setlist_items: fail("permission denied for table setlist_items", 403) });
    mount();
    await retitle("Opener (acoustic)");
    expect(queued).toEqual([]);
  });
});
