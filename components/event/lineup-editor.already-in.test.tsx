// 2026-10-27 (hunt 3): two devices on the Lineup tab. The phone puts นิค2 on; the laptop
// (loaded before that, still showing her off) taps her on too. Its INSERT hits
// event_members' unique (event_id, member_id) - 23505 / 409 - and the editor rolled the
// laptop back to "ไม่มา" with Postgres' English sentence while the server had her ON,
// which is what both asked for. The OFF twin ("she was already off") has been a success
// since 17b15ef; this one is now answered the same way - and on the same terms: an
// answer with no live session behind it is still not a save.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, ok, fail } from "@/test/fakes/supabase";
import type { SupabaseFake, RecordedCall } from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { LineupEditor } from "./lineup-editor";
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

const DUPLICATE = {
  message: 'duplicate key value violates unique constraint "event_members_event_id_member_id_key"',
  code: "23505",
};

let supa: SupabaseFake;
/** who the server has in the lineup: the phone already put m2 on */
let server: string[] = [];

function fake(session: ReturnType<typeof makeSession> | null, refuse?: { message: string; code: string }) {
  supa = makeSupabaseFake({ session });
  supa.setTable("event_members", (call: RecordedCall) => {
    if (call.verb === "insert") {
      if (refuse) return fail(refuse, 403);
      const v = call.values as { member_id: string };
      if (server.includes(v.member_id)) return fail(DUPLICATE, 409);
      server.push(v.member_id);
      return ok([{ member_id: v.member_id }]);
    }
    return ok([]);
  });
  h.supa = supa;
}

const onChange = vi.fn();
function mount() {
  return render(
    <ConfirmProvider>
      <LineupEditor
        eventId="e1"
        tenantId="t1"
        editable
        members={[1, 2, 3].map(member)}
        initialLineup={["m1"]} // the laptop loaded before the phone's tap
        onChange={onChange}
      />
    </ConfirmProvider>
  );
}
const button = (nick: string) => screen.getByRole("button", { name: new RegExp(nick) });
const pressed = (nick: string) => button(nick).getAttribute("aria-pressed");
const settled = () => waitFor(() => expect(unsavedWork().pending).toBe(0));

beforeEach(() => {
  server = ["m1", "m2"];
  toast.error.mockClear();
  onChange.mockClear();
  resetDirtyGuard();
});
afterEach(() => resetDirtyGuard());

describe("LineupEditor · turning on a member another device already turned on", () => {
  it("she stays ON, บันทึกแล้ว, no failure and no Postgres sentence", async () => {
    fake(makeSession());
    mount();
    await userEvent.click(button("นิค2"));
    await settled();
    expect(supa.callsTo("event_members", "insert")).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(pressed("นิค2")).toBe("true");
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
    expect(unsavedWork().failed).toBe(0);
    // the page (Mics, Summary) was never told she left again
    expect(onChange.mock.calls.at(-1)![0]).toEqual(["m1", "m2"]);
    expect(server).toEqual(["m1", "m2"]);
  });

  it("a member nobody had turned on is still simply added", async () => {
    fake(makeSession());
    mount();
    await userEvent.click(button("นิค3"));
    await settled();
    expect(server).toEqual(["m1", "m2", "m3"]);
    expect(pressed("นิค3")).toBe("true");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("with no live session behind the answer it is NOT a save: ยังไม่ได้บันทึก, and she is shown off again", async () => {
    fake(null);
    mount();
    await userEvent.click(button("นิค2"));
    await settled();
    expect(unsavedWork().failed).toBe(1);
    expect(toast.error).toHaveBeenCalledWith("ยังไม่ได้บันทึก", expect.anything());
    expect(pressed("นิค2")).toBe("false");
  });

  it("any other refusal still rolls back with the reason", async () => {
    fake(makeSession(), { message: "new row violates row-level security policy", code: "42501" });
    mount();
    await userEvent.click(button("นิค3"));
    await settled();
    expect(toast.error).toHaveBeenCalledWith(
      "บันทึกไม่สำเร็จ",
      // the reason, in the user's words since 2026-10-27 (hunt 7, lib/write-guard.ts writeErrorText)
      expect.objectContaining({ description: expect.stringContaining("ไม่มีสิทธิ์บันทึก") })
    );
    expect(pressed("นิค3")).toBe("false");
    expect(unsavedWork().failed).toBe(1);
  });
});
