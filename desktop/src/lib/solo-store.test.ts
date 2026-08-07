// The on-device store behind Quick Show (โหมดโชว์เดี่ยว).
//
// This is the ONLY persistence the break-glass runner has: no Supabase, no
// network, no server copy. If a write silently does nothing, the operator's
// show is gone at the next launch and there is nothing to restore it from — so
// the two things worth proving here are (a) what comes BACK is in show order and
// carries the fields the page reads, and (b) a write that could not happen
// REJECTS, loudly, instead of resolving like a success.
//
// ⚠️ HARNESS NOTE, read before adding a blob assertion: fake-indexeddb clones
// with the environment's structuredClone, which does not know jsdom's Blob and
// flattens it to `{}`. Audio bytes therefore CANNOT be round-tripped through
// IndexedDB in this project — a `blob` assertion here would be asserting the
// harness, not the store. Everything about blob handling (the File→Blob boot
// migration, the broken-source set, and the rule that a later write must never
// null a dead reference out) is proven against the page instead, in
// desktop/src/pages/my-show.test.tsx, where the store is a recording double and
// the blobs stay real.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deleteSoloItem,
  getSoloLastRun,
  listSoloItems,
  putSoloItem,
  putSoloItems,
  setSoloLastRun,
  soloStorageBytes,
  type SoloItem,
} from "~/lib/solo-store";

const DB_NAME = "cueiq-solo";

function wipe(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function item(id: string, sortOrder: number, over: Partial<SoloItem> = {}): SoloItem {
  return {
    id,
    kind: "break",
    title: id,
    fileName: null,
    blob: null,
    durationSeconds: 120,
    bufferAfterSeconds: 0,
    overlapLeadSeconds: 0,
    loop: false,
    volume: 100,
    sortOrder,
    ...over,
  };
}

beforeEach(async () => {
  await wipe();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listSoloItems — the running order comes back in show order", () => {
  it("sorts by sortOrder, not by insertion or by key", async () => {
    // Written deliberately out of order and with ids whose alphabetical order
    // disagrees with the show's: getAll() returns records in KEY order, so a
    // store that forgot to sort would look correct for a show built front to
    // back and silently reorder one that was rearranged.
    await putSoloItem(item("c-third", 3));
    await putSoloItem(item("a-second", 2));
    await putSoloItem(item("b-first", 1));

    const rows = await listSoloItems();

    expect(rows.map((r) => r.id)).toEqual(["b-first", "a-second", "c-third"]);
    expect(rows.map((r) => r.sortOrder)).toEqual([1, 2, 3]);
  });

  it("defaults overlapLeadSeconds on records that predate the field", async () => {
    // เล่นสวน arrived after the first release, so a show built before it has
    // records with no such property at all. The page does arithmetic on this
    // value on every Auto tick (`blockSeconds(cur) - …` against `lead`), and
    // `undefined` there poisons the comparison rather than throwing — the
    // pre-roll simply never fires and nothing says why.
    const legacy = item("legacy", 1) as Partial<SoloItem>;
    delete legacy.overlapLeadSeconds;
    await putSoloItem(legacy as SoloItem);

    const [row] = await listSoloItems();

    expect("overlapLeadSeconds" in (legacy as object)).toBe(false); // the record really lacks it
    expect(row.overlapLeadSeconds).toBe(0);
  });

  it("does not overwrite a lead the operator actually set", async () => {
    // The other half of the same line: `?? 0` must not become `|| 0`, and the
    // default must not be applied to every record on the way past. A 5-second
    // สวน that quietly reset itself to 0 on every launch would be reported as
    // "the overlap doesn't work", not as a store bug.
    await putSoloItem(item("with-lead", 1, { kind: "song", overlapLeadSeconds: 5 }));
    await putSoloItem(item("no-lead", 2, { kind: "song", overlapLeadSeconds: 0 }));

    const rows = await listSoloItems();

    expect(rows.map((r) => r.overlapLeadSeconds)).toEqual([5, 0]);
  });

  it("round-trips the fields the countdown is computed from", async () => {
    await putSoloItem(
      item("song", 1, {
        kind: "song",
        title: "Opening",
        fileName: "opening.mp3",
        durationSeconds: 225,
        bufferAfterSeconds: 15,
        loop: true,
        volume: 80,
      })
    );

    const [row] = await listSoloItems();

    expect(row).toMatchObject({
      id: "song",
      kind: "song",
      title: "Opening",
      fileName: "opening.mp3",
      durationSeconds: 225,
      bufferAfterSeconds: 15,
      loop: true,
      volume: 80,
      sortOrder: 1,
    });
  });
});

describe("putSoloItems / deleteSoloItem", () => {
  it("writes a whole renumbered order in one pass", async () => {
    // What a drag-reorder does: every moved row is rewritten with a new
    // sortOrder. A partial apply would leave two rows claiming the same slot.
    await putSoloItems([item("a", 1), item("b", 2), item("c", 3)]);
    await putSoloItems([item("c", 1), item("a", 2), item("b", 3)]);

    const rows = await listSoloItems();

    expect(rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("removes only the row it was asked to remove", async () => {
    await putSoloItems([item("a", 1), item("b", 2), item("c", 3)]);

    await deleteSoloItem("b");

    expect((await listSoloItems()).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("resolves on an empty list without touching storage at all", async () => {
    // The early return in putSoloItems is not decoration: reorderTo() can be
    // handed an empty list, and an IndexedDB transaction with no requests never
    // fires oncomplete in every implementation. Proven by removing IndexedDB
    // entirely — if the guard did not execute, this would reject.
    vi.stubGlobal("indexedDB", undefined);

    await expect(putSoloItems([])).resolves.toBeUndefined();
  });
});

describe("the saved last run", () => {
  it("stores and reads back a run record", async () => {
    const rec = { seconds: 3671, at: Date.UTC(2026, 7, 8, 12, 0, 0) };

    await setSoloLastRun(rec);

    expect(await getSoloLastRun()).toEqual(rec);
  });

  it("clears with null, and an absent record reads as null (not as 0)", async () => {
    expect(await getSoloLastRun()).toBeNull();

    await setSoloLastRun({ seconds: 60, at: 1 });
    await setSoloLastRun(null);

    expect(await getSoloLastRun()).toBeNull();
  });

  it("keeps the last run when the running order is emptied", async () => {
    // จบโชว์ records the time; clearing the setlist afterwards must not erase it
    // — different object store, on purpose.
    await setSoloLastRun({ seconds: 900, at: 2 });
    await putSoloItems([item("a", 1)]);
    await deleteSoloItem("a");

    expect(await listSoloItems()).toEqual([]);
    expect(await getSoloLastRun()).toEqual({ seconds: 900, at: 2 });
  });
});

describe("when this machine has no IndexedDB at all", () => {
  // Private windows, a corrupted profile, a locked-down kiosk build. The store
  // deliberately answers reads with "nothing" and lets WRITES reject, because
  // Quick Show can open on an empty list but must never tell the operator their
  // show is saved when it is not — my-show.tsx turns exactly this rejection into
  // the "บันทึกลงเครื่องไม่สำเร็จ" toast.
  beforeEach(() => {
    vi.stubGlobal("indexedDB", undefined);
  });

  it("reads answer empty instead of throwing", async () => {
    await expect(listSoloItems()).resolves.toEqual([]);
    await expect(getSoloLastRun()).resolves.toBeNull();
    await expect(soloStorageBytes()).resolves.toBe(0);
  });

  it("a write REJECTS — it must never look saved", async () => {
    await expect(putSoloItem(item("a", 1))).rejects.toThrow(/IndexedDB unavailable/);
    await expect(putSoloItems([item("a", 1)])).rejects.toThrow(/IndexedDB unavailable/);
    await expect(deleteSoloItem("a")).rejects.toThrow(/IndexedDB unavailable/);
    await expect(setSoloLastRun({ seconds: 1, at: 1 })).rejects.toThrow(
      /IndexedDB unavailable/
    );
  });
});

describe("soloStorageBytes", () => {
  it("is 0 for a show made only of MC blocks", async () => {
    await putSoloItems([item("mc1", 1), item("mc2", 2)]);

    expect(await soloStorageBytes()).toBe(0);
  });
});
