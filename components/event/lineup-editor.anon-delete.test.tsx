// 2026-10-27: the Lineup tab must not say บันทึกแล้ว over a write that changed nothing.
//
// Its writes asked for no rows back, and success was `if (!error)`. In the minute after a
// venue reconnect (an expired token whose refresh failed - supabase-js falls back to the
// ANON key; lib/write-guard.ts, lib/auth-session.ts hasLiveSession) RLS matches no row,
// PostgREST answers 204 with error null, and the tab said บันทึกแล้ว while the member
// taken off (sick on the day) stayed in event_members: the run sheet, the JPG, the Excel
// sheet and the Mic Map seed kept her on stage. Every Lineup write now asks for its rows
// back, and NO row with NO live session is "ยังไม่ได้บันทึก" + the member put back.
// With a live session 0 rows is the server agreeing - she was already off (another
// device), or เลือกทั้งหมด's upsert ignored members already in - and stays a success.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeSupabaseFake,
  makeSession,
  type RecordedCall,
  type ScriptResult,
  type SupabaseFake,
} from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { LineupEditor } from "@/components/event/lineup-editor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard, unsavedWork } from "@/lib/dirty-guard";

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

/** A write that matched no row, as PostgREST answers it: asked for its rows back
 *  (return=representation) it is 200 + []; not asked, 204 + no body. Either way no error. */
function matchedNothing(call: RecordedCall): ScriptResult {
  return call.selectAfterWrite
    ? { data: [], error: null, status: 200 }
    : { data: null, error: null, status: 204 };
}

let supa: SupabaseFake;
function fake(session: ReturnType<typeof makeSession> | null) {
  supa = makeSupabaseFake({ session, script: { event_members: matchedNothing } });
  h.supa = supa;
}
beforeEach(() => {
  resetDirtyGuard();
  toast.error.mockClear();
});
afterEach(() => resetDirtyGuard());

function mount(initialLineup = ["m1", "m2", "m3"]) {
  return render(
    <ConfirmProvider>
      <LineupEditor
        eventId="e1"
        tenantId="t1"
        editable
        members={[1, 2, 3].map(member)}
        initialLineup={initialLineup}
      />
    </ConfirmProvider>
  );
}
const button = (nick: string) => screen.getByRole("button", { name: new RegExp(nick) });
const pressed = (nick: string) => button(nick).getAttribute("aria-pressed");
const settled = () => waitFor(() => expect(unsavedWork().pending).toBe(0));

describe("LineupEditor · a write that changed nothing on the server", () => {
  it("no session: taking a member off that removed nobody is ยังไม่ได้บันทึก, and she is back on", async () => {
    fake(null); // supabase-js has fallen back to the anon key
    mount();
    await userEvent.click(button("นิค2"));
    await settled();
    expect(screen.queryByText("บันทึกแล้ว")).toBeNull();
    expect(screen.getByText("ยังไม่ได้บันทึก")).toBeTruthy();
    expect(unsavedWork().failed).toBe(1);
    expect(toast.error).toHaveBeenCalledWith(
      "ยังไม่ได้บันทึก",
      expect.objectContaining({ description: expect.stringContaining("เซสชันหมดอายุ") })
    );
    expect(pressed("นิค2"), "the screen shows what the server holds").toBe("true");
    expect(supa.lastCall("event_members", "delete")!.selectAfterWrite, "the delete asks for its rows back").toBe(true);
  });

  it("no session: ล้าง that removed nobody is ยังไม่ได้บันทึก, and everyone is back on", async () => {
    fake(null);
    mount();
    await userEvent.click(screen.getByRole("button", { name: /ล้าง$/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ล้างทั้งหมด" }));
    await settled();
    expect(screen.queryByText("บันทึกแล้ว")).toBeNull();
    expect(unsavedWork().failed).toBe(1);
    expect([pressed("นิค1"), pressed("นิค2"), pressed("นิค3")]).toEqual(["true", "true", "true"]);
    expect(supa.lastCall("event_members", "delete")!.selectAfterWrite).toBe(true);
  });

  it("no session: putting a member back that inserted nobody is ยังไม่ได้บันทึก too", async () => {
    fake(null);
    mount(["m1"]);
    await userEvent.click(button("นิค3"));
    await settled();
    expect(unsavedWork().failed).toBe(1);
    expect(pressed("นิค3")).toBe("false");
    expect(supa.lastCall("event_members", "insert")!.selectAfterWrite).toBe(true);
  });

  it("live session: a delete that removed nobody (she was already off) is still บันทึกแล้ว", async () => {
    fake(makeSession());
    mount();
    await userEvent.click(button("นิค2"));
    await settled();
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
    expect(unsavedWork().failed).toBe(0);
    expect(toast.error).not.toHaveBeenCalled();
    expect(pressed("นิค2")).toBe("false");
  });

  it("live session: เลือกทั้งหมด whose upsert ignored members already in is still บันทึกแล้ว", async () => {
    fake(makeSession());
    mount(["m1"]);
    await userEvent.click(screen.getByRole("button", { name: /เลือกทั้งหมด/ }));
    await settled();
    expect(supa.lastCall("event_members", "upsert")!.selectAfterWrite).toBe(true);
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    expect([pressed("นิค1"), pressed("นิค2"), pressed("นิค3")]).toEqual(["true", "true", "true"]);
  });
});
