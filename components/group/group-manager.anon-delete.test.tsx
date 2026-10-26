// 2026-10-27 hunt 3 (admin): 17b15ef made the crew contact delete ask for its row back (an
// anon delete in the reconnect minute: RLS matches no row, no error). Its siblings on the
// Artists page were left: deleteMember and deleteGroup read only `error`, so the member /
// band vanished from the screen with no toast and was back on the next load - and in the
// Lineup and the Mic Map. deleteGroup also went on past a FAILED songs/events read, which
// cascaded the rows away with their R2 masters still in the bucket, unreachable for good.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import {
  fail,
  makeSupabaseFake,
  ok,
  type RecordedCall,
  type ScriptResult,
  type SupabaseFake,
} from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import type { Group, Member } from "@/lib/types";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.db }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const audio = vi.hoisted(() => ({ removeEventAudio: vi.fn(async () => {}) }));
vi.mock("@/lib/audio-remote", () => audio);

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GroupManager } from "@/components/group/group-manager";

const T = "33333333-3333-4333-8333-333333333333";
const G: Group = {
  id: "g1", tenant_id: T, name: "Seishin Kakumei", color: "#A62A1C", skin: null,
  exempt_from_deadline: false, self_photo: true, contact_name: null, contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
};
const M: Member = {
  id: "m1", tenant_id: T, group_id: "g1", name: "Yuki", nickname: null, mic_number: 1,
  color: null, sort_order: 1, created_at: "2026-01-01T00:00:00Z",
};

/** A write that matched no row, as PostgREST answers it: asked for its rows back it is
 *  200 + []; not asked, 204 + no body. Either way no error. */
function matchedNothing(call: RecordedCall): ScriptResult {
  return call.selectAfterWrite
    ? { data: [], error: null, status: 200 }
    : { data: null, error: null, status: 204 };
}

function mount(db: SupabaseFake) {
  h.db = db;
  render(
    <ConfirmProvider>
      <GroupManager tenantId={T} initialGroups={[G]} initialMembers={[M]} perms={makePerms("admin", [])} />
    </ConfirmProvider>
  );
}

async function confirmBandDelete() {
  fireEvent.click(screen.getByRole("button", { name: /ลบวง/ }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(`พิมพ์ ${G.name} เพื่อยืนยัน`), {
    target: { value: G.name },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "ลบวง" }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Artists: a delete that touched no row", () => {
  it("a member delete sent as anon keeps the member on screen and says so", async () => {
    const db = makeSupabaseFake({ script: { members: (c) => (c.verb === "delete" ? matchedNothing(c) : ok([])) } });
    mount(db);
    fireEvent.click(screen.getByRole("button", { name: "ลบสมาชิก" }));
    fireEvent.click(await screen.findByRole("button", { name: /^ลบ$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(db.callsTo("members", "delete")[0].selectAfterWrite).toBe(true);
    expect(toast.error.mock.calls[0][0]).toBe("ลบไม่สำเร็จ");
    expect(screen.getAllByLabelText("ชื่อ")).toHaveLength(1);
  });

  it("a band delete sent as anon keeps the band on screen and says so", async () => {
    const db = makeSupabaseFake({
      script: {
        songs: ok([]),
        events: ok([]),
        groups: (c) => (c.verb === "delete" ? matchedNothing(c) : ok([])),
      },
    });
    mount(db);
    await confirmBandDelete();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(db.callsTo("groups", "delete")[0].selectAfterWrite).toBe(true);
    expect(toast.error.mock.calls[0][0]).toBe("ลบไม่สำเร็จ");
    expect(screen.getByRole("region", { name: G.name })).toBeTruthy();
    expect(screen.getAllByLabelText("ชื่อ")).toHaveLength(1);
  });
});

describe("Artists: a band delete whose audio-file read failed", () => {
  it.each(["songs", "events"])("refuses when the %s read failed - no file and no row deleted", async (table) => {
    const db = makeSupabaseFake({
      script: {
        songs: ok([{ audio_path: "t/g1/songs/a.wav" }]),
        events: ok([{ id: "e1" }]),
        setlist_items: ok([{ audio_path: "t/g1/events/e1/b.wav" }]),
        [table]: fail("canceling statement due to statement timeout", 500),
        groups: ok([{ id: G.id }]),
      },
    });
    mount(db);
    await confirmBandDelete();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(db.callsTo("groups", "delete")).toHaveLength(0);
    expect(audio.removeEventAudio).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: G.name })).toBeTruthy();
  });

  it("still deletes when every read answered (the masters first, then the row)", async () => {
    const db = makeSupabaseFake({
      script: {
        songs: ok([{ audio_path: "t/g1/songs/a.wav" }]),
        events: ok([{ id: "e1" }]),
        setlist_items: ok([{ audio_path: "t/g1/events/e1/b.wav" }]),
        groups: ok([{ id: G.id }]),
      },
    });
    mount(db);
    await confirmBandDelete();
    await waitFor(() => expect(db.callsTo("groups", "delete")).toHaveLength(1));
    expect(audio.removeEventAudio).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("region", { name: G.name })).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });
});
