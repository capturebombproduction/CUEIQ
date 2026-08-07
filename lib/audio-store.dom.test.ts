// The on-device Live Mode audio cache. Everything here is about ONE question the
// operator cannot ask at the venue: "are the bytes for tonight's show really on
// this machine?" A wrong answer is silent — the row lists, the object URL mints,
// and nothing comes out of the PA.
//
// `.dom.test.ts` on purpose: this module is nothing but IndexedDB, and in the node
// project every function would take its "IndexedDB unavailable" branch and the file
// would pass while asserting the fallback.
//
// The jsdom setup already imports fake-indexeddb; this line is a no-op there and
// keeps the file runnable on its own.
import "fake-indexeddb/auto";
import { Blob as StorableBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAllAudio,
  clearEventAudio,
  deleteAudio,
  getCacheSummary,
  listCachedEntries,
  loadAudioForEvent,
  saveAudio,
} from "@/lib/audio-store";

const EV = "ev-tonight";
const OTHER = "ev-tomorrow";

/** fake-indexeddb is module state, and jsdom isolation is per FILE, not per test —
 *  without this every test inherits the previous one's cache. */
function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Blobs are compared by their BYTES: a record that lists correctly and plays
 *  nothing is exactly the failure this module exists to catch. */
async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * ⚠️ NOT `new Blob(...)`. fake-indexeddb structured-clones every stored value, and
 * this environment's structuredClone does not understand jsdom's Blob: it comes
 * back as a bare `{}` — no size, no bytes — so a jsdom-seeded test would be
 * measuring the harness's clone rather than the cache (and would read every record
 * as suspect). Node's Blob clones faithfully and satisfies everything this module
 * asks of the value: `.size`, `instanceof File`, and being handed to
 * URL.createObjectURL. Real browsers store either one.
 */
const audio = (...bytes: number[]) =>
  new StorableBlob([new Uint8Array(bytes)], { type: "audio/mpeg" }) as unknown as Blob;

beforeEach(async () => {
  await deleteDB("cueiq-audio");
});

describe("saveAudio → loadAudioForEvent", () => {
  it("round-trips the bytes, the name and the storage path they came from", async () => {
    await saveAudio(EV, "item-1", audio(1, 2, 3, 4), "opening.mp3", "tenant/band/opening.mp3");

    const [row, ...rest] = await loadAudioForEvent(EV);
    expect(rest).toEqual([]);
    expect(row.itemId).toBe("item-1");
    expect(row.name).toBe("opening.mp3");
    expect(row.path).toBe("tenant/band/opening.mp3");
    expect(await bytesOf(row.blob)).toEqual([1, 2, 3, 4]);
  });

  // The path is how a REPLACED file invalidates the cache (a new upload gets a new
  // path). A legacy/local-only record has none, and it must read back as an explicit
  // null — `undefined` would compare unequal to the null the readiness check expects.
  it("a save with no path records null, not undefined", async () => {
    await saveAudio(EV, "item-1", audio(9), "local.mp3");
    const [row] = await loadAudioForEvent(EV);
    expect(row.path).toBeNull();
  });

  it("re-saving the same item replaces it instead of stacking a second copy", async () => {
    await saveAudio(EV, "item-1", audio(1), "old.mp3", "p/old.mp3");
    await saveAudio(EV, "item-1", audio(2, 2), "new.mp3", "p/new.mp3");

    const rows = await loadAudioForEvent(EV);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("new.mp3");
    expect(rows[0].path).toBe("p/new.mp3");
    expect(await bytesOf(rows[0].blob)).toEqual([2, 2]);
  });

  it("an event with nothing cached loads empty rather than throwing", async () => {
    await saveAudio(OTHER, "item-1", audio(1), "other.mp3");
    expect(await loadAudioForEvent(EV)).toEqual([]);
  });

  it("one event's rows never come back under another event", async () => {
    await saveAudio(EV, "a", audio(1), "a.mp3");
    await saveAudio(OTHER, "b", audio(2), "b.mp3");

    expect((await loadAudioForEvent(EV)).map((r) => r.itemId)).toEqual(["a"]);
    expect((await loadAudioForEvent(OTHER)).map((r) => r.itemId)).toEqual(["b"]);
  });

  // The keys are string-prefixed, so an id that is a PREFIX of another id is the
  // case a naive startsWith gets wrong. "ev1::" cannot match "ev10::…" only because
  // the separator is part of the prefix — worth pinning, it is one character deep.
  it("an event id that is a prefix of another event's id does not bleed", async () => {
    await saveAudio("ev1", "a", audio(1), "a.mp3");
    await saveAudio("ev10", "b", audio(2), "b.mp3");

    expect((await loadAudioForEvent("ev1")).map((r) => r.itemId)).toEqual(["a"]);
    expect((await loadAudioForEvent("ev10")).map((r) => r.itemId)).toEqual(["b"]);
  });
});

describe("listCachedEntries", () => {
  it("keys by itemId and reports the source path, without an entry for what is not cached", async () => {
    await saveAudio(EV, "cached", audio(1, 2), "a.mp3", "p/a.mp3");

    const entries = await listCachedEntries(EV);
    expect(entries.cached).toEqual({ path: "p/a.mp3", suspect: false });
    expect(entries["never-cached"]).toBeUndefined();
  });

  it("is scoped to the event, prefix siblings included", async () => {
    await saveAudio("ev1", "a", audio(1), "a.mp3");
    await saveAudio("ev10", "b", audio(2), "b.mp3");
    await saveAudio(OTHER, "c", audio(3), "c.mp3");

    expect(Object.keys(await listCachedEntries("ev1"))).toEqual(["a"]);
  });

  it("a zero-byte record is suspect — there is nothing to play", async () => {
    await saveAudio(EV, "empty", audio(), "empty.mp3", "p/empty.mp3");
    const entries = await listCachedEntries(EV);
    expect(entries.empty.suspect).toBe(true);
    // …but it still reports where it came from, so the caller can re-fetch it.
    expect(entries.empty.path).toBe("p/empty.mp3");
  });

  it("a record written without bytes at all is suspect", async () => {
    await saveAudio(EV, "headless", undefined as unknown as Blob, "gone.mp3", "p/gone.mp3");
    expect((await listCachedEntries(EV)).headless.suspect).toBe(true);
  });

  // The failure only discoverable on stage: Chromium persists a File as a REFERENCE
  // to the original on disk, so a moved / unplugged source still lists and still
  // mints an object URL. The product asks `blob instanceof File`; storing a real
  // File here would make the assertion depend on whether THIS Node's structured
  // clone preserves File-ness (fake-indexeddb clones every stored value), so point
  // the predicate's constructor at the class the stored blob actually is — same
  // branch, no clone lottery.
  it("a record holding the picked File rather than a copy is suspect", async () => {
    await saveAudio(EV, "picked", audio(1, 2, 3), "picked.mp3", "p/picked.mp3");
    const RealFile = globalThis.File;
    (globalThis as unknown as { File: unknown }).File = StorableBlob;
    try {
      expect((await listCachedEntries(EV)).picked.suspect).toBe(true);
    } finally {
      (globalThis as unknown as { File: unknown }).File = RealFile;
    }
  });

  it("a plain Blob with bytes is NOT suspect, even where File is undefined", async () => {
    await saveAudio(EV, "good", audio(1, 2, 3), "good.mp3", "p/good.mp3");
    expect((await listCachedEntries(EV)).good.suspect).toBe(false);

    const RealFile = globalThis.File;
    (globalThis as unknown as { File: unknown }).File = undefined;
    try {
      expect((await listCachedEntries(EV)).good.suspect).toBe(false);
    } finally {
      (globalThis as unknown as { File: unknown }).File = RealFile;
    }
  });
});

describe("getCacheSummary", () => {
  it("adds up the bytes and the files, broken down per event", async () => {
    await saveAudio(EV, "a", audio(1, 2, 3), "a.mp3");
    await saveAudio(EV, "b", audio(4, 5), "b.mp3");
    await saveAudio(OTHER, "c", audio(6), "c.mp3");

    const summary = await getCacheSummary();
    expect(summary).toEqual({
      totalBytes: 6,
      fileCount: 3,
      byEvent: {
        [EV]: { bytes: 5, count: 2 },
        [OTHER]: { bytes: 1, count: 1 },
      },
    });
  });

  it("a record with no bytes still counts as a file taking up a slot", async () => {
    await saveAudio(EV, "headless", undefined as unknown as Blob, "gone.mp3");
    const summary = await getCacheSummary();
    expect(summary.fileCount).toBe(1);
    expect(summary.totalBytes).toBe(0);
  });

  it("an empty cache summarises to zeroes, not to a rejection", async () => {
    expect(await getCacheSummary()).toEqual({ totalBytes: 0, fileCount: 0, byEvent: {} });
  });
});

describe("clearEventAudio", () => {
  it("removes only that event's files and returns how many it removed", async () => {
    await saveAudio(EV, "a", audio(1), "a.mp3");
    await saveAudio(EV, "b", audio(2), "b.mp3");
    await saveAudio(OTHER, "c", audio(3), "c.mp3");

    expect(await clearEventAudio(EV)).toBe(2);
    expect(await loadAudioForEvent(EV)).toEqual([]);
    expect((await loadAudioForEvent(OTHER)).map((r) => r.itemId)).toEqual(["c"]);
  });

  it("clearing an event that has nothing cached removes nothing and reports 0", async () => {
    await saveAudio(OTHER, "c", audio(3), "c.mp3");
    expect(await clearEventAudio(EV)).toBe(0);
    expect(await loadAudioForEvent(OTHER)).toHaveLength(1);
  });

  it("does not take a prefix-sibling event's files with it", async () => {
    await saveAudio("ev1", "a", audio(1), "a.mp3");
    await saveAudio("ev10", "b", audio(2), "b.mp3");

    expect(await clearEventAudio("ev1")).toBe(1);
    expect((await loadAudioForEvent("ev10")).map((r) => r.itemId)).toEqual(["b"]);
  });
});

describe("deleteAudio / clearAllAudio", () => {
  it("deleteAudio drops one item and leaves the rest of the show alone", async () => {
    await saveAudio(EV, "a", audio(1), "a.mp3");
    await saveAudio(EV, "b", audio(2), "b.mp3");

    await deleteAudio(EV, "a");
    expect((await loadAudioForEvent(EV)).map((r) => r.itemId)).toEqual(["b"]);
  });

  it("deleting something that was never cached is a no-op, not a rejection", async () => {
    await saveAudio(EV, "a", audio(1), "a.mp3");
    await deleteAudio(EV, "never-there");
    expect(await loadAudioForEvent(EV)).toHaveLength(1);
  });

  it("clearAllAudio wipes every event", async () => {
    await saveAudio(EV, "a", audio(1), "a.mp3");
    await saveAudio(OTHER, "c", audio(3), "c.mp3");

    await clearAllAudio();
    expect(await getCacheSummary()).toEqual({ totalBytes: 0, fileCount: 0, byEvent: {} });
  });
});

describe("with no IndexedDB at all", () => {
  const real = globalThis.indexedDB;
  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = real;
  });

  // Unlike lib/local-source.ts (playback hot path, defends itself), this module
  // REJECTS — the prefetch loop counts a rejection as a failed file and moves on,
  // where a silent empty answer would report the show as ready with no audio.
  it("rejects rather than answering 'nothing is cached'", async () => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    await expect(listCachedEntries(EV)).rejects.toThrow(/IndexedDB unavailable/);
    await expect(saveAudio(EV, "a", audio(1), "a.mp3")).rejects.toThrow(/IndexedDB unavailable/);
  });
});
