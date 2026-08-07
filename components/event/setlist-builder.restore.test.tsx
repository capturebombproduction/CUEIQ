import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import {
  makeSession,
  makeSupabaseFake,
  ok,
  type RecordedCall,
  type ScriptResult,
  type SupabaseFake,
} from "@/test/fakes/supabase";

// RESTORING A SAVED SETLIST VERSION is a two-step write with no transaction:
// insert the snapshot rows, then delete the old ones. The delete used to be
// `.delete().in("id", …)` destructuring only `error`, so a 204-with-zero-rows —
// what an RLS-filtered (anon) request returns in the minute after a venue
// reconnect — read as success. There is no unique constraint on
// (event_id, sort_order), so what the DB then holds is the ORIGINAL setlist PLUS
// a full duplicate, and that is what the printed run sheet and Live Mode use.
//
// The rollback a few lines down ("don't leave BOTH sets") had the identical hole,
// so the repair could silently no-op too. Both are asserted here, and the happy
// path is asserted alongside them so the test cannot be satisfied by a restore
// that simply never works.

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

// Toasts are the only user-visible outcome of the failure paths; spy on the calls
// rather than on their Thai copy.
const toastSpy = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastSpy, Toaster: () => null }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
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
    audio_path: null, // keeps the legacy R2 cleanup (a real fetch) out of the test
    audio_name: null,
    loop_audio: false,
  };
}

/** On screen when the restore starts. */
const OLD = [item("old-1", 1, "Old A"), item("old-2", 2, "Old B")];
/** What the insert of the snapshot rows returns. */
const INSERTED = [item("new-1", 1, "Saved A"), item("new-2", 2, "Saved B")];

const VERSION = {
  id: "v-1",
  label: "before rehearsal",
  created_at: "2026-08-01T10:00:00.000Z",
  snapshot: INSERTED.map((r) => ({
    kind: r.kind,
    title: r.title,
    sort_order: r.sort_order,
    duration_seconds: r.duration_seconds,
    buffer_before_seconds: r.buffer_before_seconds,
    buffer_after_seconds: r.buffer_after_seconds,
    mic_slots: r.mic_slots,
    notes: r.notes,
    song_id: r.song_id,
    loop_audio: false,
  })),
};

let supa: SupabaseFake;
let realConfirm: typeof window.confirm | undefined;

/**
 * `onDelete` sees every delete in restore order: call 1 removes the OLD rows,
 * call 2 (if any) is the rollback of the freshly inserted ones.
 */
function scriptRestore(onDelete: (call: RecordedCall, nth: number) => ScriptResult) {
  let deletes = 0;
  supa.setScript({
    setlist_versions: ok([VERSION]),
    setlist_items: (call) => {
      if (call.verb === "insert") return ok(INSERTED);
      if (call.verb === "delete") return onDelete(call, ++deletes);
      return ok([]); // the reality refetch
    },
  });
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  // The setup file deliberately leaves window.confirm undefined; SetlistVersions
  // gates its restore on it. Install it here, remove it after.
  realConfirm = window.confirm;
  window.confirm = vi.fn(() => true);
});

afterEach(() => {
  window.confirm = realConfirm as typeof window.confirm;
});

function renderBuilder() {
  return render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={OLD}
        showStartTime="19:00"
        hardOutTime={null}
        members={[]}
        songs={[]}
        eventName="Test show"
      />
    </ConfirmProvider>
  );
}

/** Open the version dialog and press its restore button. Both are located by their
 *  lucide icon class — the Thai labels are copy and would make this brittle. */
async function runRestore() {
  const trigger = document.querySelector("svg.lucide-history")?.closest("button");
  expect(trigger, "version-history trigger button").toBeTruthy();
  fireEvent.click(trigger!);

  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(dialog.querySelector("svg.lucide-rotate-ccw"), "restore button").toBeTruthy()
  );
  const restore = dialog.querySelector("svg.lucide-rotate-ccw")!.closest("button")!;
  await act(async () => {
    fireEvent.click(restore);
  });
}

const deletesOf = (s: SupabaseFake) => s.callsTo("setlist_items", "delete");
const idsIn = (call: RecordedCall) =>
  (call.filters.find((f) => f.op === "in" && f.column === "id")?.value ?? []) as string[];

describe("SetlistBuilder — restoring a saved version", () => {
  it("replaces the setlist when the delete really removed the old rows", async () => {
    scriptRestore(() => ok(OLD.map((r) => ({ id: r.id }))));
    renderBuilder();

    await runRestore();

    const deletes = deletesOf(supa);
    // Exactly one delete: no rollback, because nothing went wrong.
    expect(deletes).toHaveLength(1);
    expect(idsIn(deletes[0])).toEqual(["old-1", "old-2"]);
    expect(toastSpy.error).not.toHaveBeenCalled();
    // The restored titles are what the builder now shows.
    expect(await screen.findByDisplayValue("Saved A")).toBeTruthy();
    expect(screen.queryByDisplayValue("Old A")).toBeNull();
  });

  it("asks for the deleted rows back on BOTH the restore delete and its rollback", async () => {
    // Without .select() the 0-row case is unreachable: data is null,
    // wroteNothing(null) is false, and the guard below can never run.
    scriptRestore(() => ok([]));
    renderBuilder();

    await runRestore();

    const deletes = deletesOf(supa);
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    for (const call of deletes) expect(call.selectAfterWrite).toBe(true);
  });

  it("rolls the inserted snapshot back instead of leaving the setlist duplicated", async () => {
    // Delete #1 (old rows) touches nothing; delete #2 (rollback) really lands.
    scriptRestore((call, nth) => (nth === 1 ? ok([]) : ok(idsIn(call).map((id) => ({ id })))));
    renderBuilder();

    await runRestore();

    const deletes = deletesOf(supa);
    expect(deletes).toHaveLength(2);
    expect(idsIn(deletes[0])).toEqual(["old-1", "old-2"]);
    // THE FIX: the rows just inserted are taken back out, so the DB is not left
    // holding old + restored.
    expect(idsIn(deletes[1])).toEqual(["new-1", "new-2"]);
    // And the restore is reported as failed, not celebrated.
    expect(toastSpy.error).toHaveBeenCalled();
    expect(toastSpy.success).not.toHaveBeenCalled();
    // Screen still shows the setlist the server actually holds.
    expect(await screen.findByDisplayValue("Old A")).toBeTruthy();
    expect(screen.queryByDisplayValue("Saved A")).toBeNull();
  });

  it("refetches and warns when the rollback ALSO removed nothing", async () => {
    // Both writes silently no-op — the DB really is duplicated now. The UI must
    // show that rather than hide the extra rows.
    const DUPLICATED = [...OLD, ...INSERTED];
    let deletes = 0;
    supa.setScript({
      setlist_versions: ok([VERSION]),
      setlist_items: (call) => {
        if (call.verb === "insert") return ok(INSERTED);
        if (call.verb === "delete") {
          deletes++;
          return ok([]);
        }
        return ok(DUPLICATED); // the reality refetch
      },
    });
    renderBuilder();

    await runRestore();

    expect(deletes).toBe(2);
    const refetch = supa
      .callsTo("setlist_items", "select")
      .find((c) => c.eq.event_id === EVENT_ID);
    expect(refetch, "reality refetch after a failed rollback").toBeTruthy();
    expect(toastSpy.error).toHaveBeenCalled();
    // All four rows on screen: the duplication is visible, not hidden.
    expect(await screen.findByDisplayValue("Old A")).toBeTruthy();
    expect(screen.getByDisplayValue("Saved A")).toBeTruthy();
  });
});
