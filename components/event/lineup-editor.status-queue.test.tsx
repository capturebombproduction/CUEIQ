// Desktop, 2026-10-27: a Lineup tap that a SICK server refuses - a Supabase / Cloudflare
// 503 / 502 / 429, the server up and answering badly at the venue - must be queued like
// any other transient failure. isQueueableWriteError (lib/mgmt-outbox.ts) decides that
// from the HTTP status, but the Lineup tab only read { error } and never passed the
// status into tryQueueChildList: the 503 arrives as an HTML page in error.message,
// matches none of the network words, and was classed a REAL rejection - toast
// "บันทึกไม่สำเร็จ", the member snapped back, nothing queued.
// The setlist builder's twin is setlist-builder.status-queue.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSupabaseFake, makeSession, fail, type SupabaseFake } from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { LineupEditor } from "@/components/event/lineup-editor";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import type { ChildListOp, NewMgmtOp } from "@/lib/mgmt-outbox";
import { resetDirtyGuard, unsavedWork } from "@/lib/dirty-guard";

const PAGE_503 = "<html><body><h1>503 Service Unavailable</h1></body></html>";

const member = (n: number): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  queued = [];
  registerMgmtQueueSink(async (op) => {
    queued.push(op);
  });
  resetDirtyGuard();
  toast.error.mockClear();
});
afterEach(() => {
  registerMgmtQueueSink(null);
  resetDirtyGuard();
  cleanup();
});

function mount() {
  return render(
    <ConfirmProvider>
      <LineupEditor
        eventId="e1"
        tenantId="t1"
        eventName="Show"
        editable
        members={[1, 2, 3].map(member)}
        initialLineup={["m1", "m2", "m3"]}
      />
    </ConfirmProvider>
  );
}
const button = (nick: string) => screen.getByRole("button", { name: new RegExp(nick) });

describe("desktop Lineup vs a server that is up and answering badly", () => {
  it("a 503 HTML page on a tap is queued for replay; the member stays off and the tab says saved", async () => {
    supa.setScript({ event_members: fail(PAGE_503, 503) });
    mount();
    await userEvent.click(button("นิค2"));
    await waitFor(() => expect(unsavedWork().pending).toBe(0));
    expect(queued).toHaveLength(1);
    expect([...((queued[0] as ChildListOp).rows as string[])].sort()).toEqual(["m1", "m3"]);
    expect(button("นิค2").getAttribute("aria-pressed")).toBe("false");
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("a 403 is still a real rejection - never queued, the member comes back", async () => {
    supa.setScript({ event_members: fail("permission denied for table event_members", 403) });
    mount();
    await userEvent.click(button("นิค2"));
    await waitFor(() => expect(unsavedWork().failed).toBe(1));
    expect(queued).toEqual([]);
    expect(button("นิค2").getAttribute("aria-pressed")).toBe("true");
  });
});
