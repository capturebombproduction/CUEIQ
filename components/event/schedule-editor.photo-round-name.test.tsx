// 2026-10-27 (hunt 3): "+ ถ่ายรูป" named a further photo round "รอบ <count+1>" without
// looking at the names already in use. 0042's unique key is the trimmed name (unnamed =
// "ถ่ายรูป"), so once a round had been deleted - the unnamed one, or "รอบ 2" out of
// unnamed / รอบ 2 / รอบ 3 - the button's own suggestion collided: "ชื่อรอบถ่ายรูปซ้ำ"
// online for a press the band had no way to get right, and on the desktop offline a
// snapshot that parks forever. It now takes the unnamed round when that key is free,
// else the first "รอบ k" (k from count+1) whose key nobody has.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, ok, fail } from "@/test/fakes/supabase";
import type { SupabaseFake, RecordedCall } from "@/test/fakes/supabase";
import type { ScheduleItem } from "@/lib/types";
import { photoRoundKey } from "@/lib/photo-rounds";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
// The offline queue has its own tests; on the web nothing is queued and every add
// goes online, which is where 0042's key answers.
vi.mock("@/lib/mgmt-write", () => ({
  OFFLINE_QUEUED_MESSAGE: "queued",
  tryQueueChildList: vi.fn(async () => false),
  QUEUED_BEHIND_PENDING_MESSAGE: "queued behind",
  tryQueueBehindPendingChildList: vi.fn(async () => false),
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "./schedule-editor";

const photo = (id: string, label: string | null, sort: number): ScheduleItem => ({
  id,
  tenant_id: "t1",
  event_id: "e1",
  kind: "photo",
  label,
  location: null,
  start_time: null,
  end_time: null,
  notes: null,
  sort_order: sort,
});

let supa: SupabaseFake;
/** the event's schedule rows on the server */
let server: ScheduleItem[] = [];

beforeEach(() => {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      schedule_items: (call: RecordedCall) => {
        if (call.verb !== "insert") return ok([]);
        const v = call.values as ScheduleItem;
        // mig 0042: one photo row per event per trimmed name, unnamed = "ถ่ายรูป"
        if (
          v.kind === "photo" &&
          server.some((r) => r.kind === "photo" && photoRoundKey(r.label) === photoRoundKey(v.label))
        ) {
          return fail({ message: "duplicate key value violates unique constraint", code: "23505" }, 409);
        }
        const row = { ...photo(`new-${server.length}`, null, v.sort_order), ...v } as ScheduleItem;
        server.push(row);
        return ok(row);
      },
    },
  });
  h.supa = supa;
  toast.error.mockClear();
});
afterEach(() => cleanup());

async function addPhotoRound(rows: ScheduleItem[]) {
  server = rows.map((r) => ({ ...r }));
  render(
    <ConfirmProvider>
      <ScheduleEditor eventId="e1" tenantId="t1" editable initialItems={rows} eventName="งานทดสอบ" />
    </ConfirmProvider>
  );
  await userEvent.click(screen.getByRole("button", { name: /ถ่ายรูป/ }));
  await waitFor(() => expect(supa.callsTo("schedule_items", "insert")).toHaveLength(1));
  await waitFor(() => expect(supa.query.pending()).toHaveLength(0));
  return supa.callsTo("schedule_items", "insert")[0].values as Record<string, unknown>;
}
/** the round was added: on the server, and as a row on screen */
async function added(rows: number) {
  expect(toast.error).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getAllByLabelText("Type")).toHaveLength(rows));
}

describe("ScheduleEditor · + ถ่ายรูป names a round nobody has", () => {
  it("unnamed, รอบ 2, รอบ 3 with รอบ 2 deleted: the next one is รอบ 4, not a second รอบ 3", async () => {
    const values = await addPhotoRound([photo("p1", null, 1), photo("p3", "รอบ 3", 3)]);
    expect(values.label).toBe("รอบ 4");
    await added(3);
    expect(server.filter((r) => r.kind === "photo").map((r) => photoRoundKey(r.label))).toEqual([
      "ถ่ายรูป",
      "รอบ 3",
      "รอบ 4",
    ]);
  });

  it("the unnamed round deleted and รอบ 2 left: the new one takes the free unnamed key", async () => {
    const values = await addPhotoRound([photo("p2", "รอบ 2", 2)]);
    expect(values.label).toBeUndefined();
    await added(2);
    expect(server.filter((r) => r.kind === "photo")).toHaveLength(2);
  });

  it("a round renamed to the next suggestion is stepped over too", async () => {
    // unnamed + one renamed "รอบ 3": count+1 = 3 is taken, so 4
    const values = await addPhotoRound([photo("p1", "  ", 1), photo("p2", " รอบ 3 ", 2)]);
    expect(values.label).toBe("รอบ 4");
    await added(3);
  });

  it("unnamed + รอบ 2 still suggests รอบ 3, as it always did", async () => {
    const values = await addPhotoRound([photo("p1", null, 1), photo("p2", "รอบ 2", 2)]);
    expect(values.label).toBe("รอบ 3");
    await added(3);
  });
});
