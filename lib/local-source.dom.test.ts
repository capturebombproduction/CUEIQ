// Per-device local audio overrides. Two things matter here and nothing else does:
// the bytes come back exactly as they went in, and a READ never throws — it sits on
// the playback hot path, where a rejection would take the song down instead of
// falling back to the online master.
//
// `.dom.test.ts` on purpose: in the node project every call would take the
// "IndexedDB unavailable" branch and the file would pass while asserting nothing.
//
// The jsdom setup already imports fake-indexeddb; this line is a no-op there and
// keeps the file runnable on its own.
import "fake-indexeddb/auto";
import { Blob as StorableBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearLocalSource,
  getLocalSource,
  listLocalSourceIds,
  setLocalSource,
} from "@/lib/local-source";

const SONG = "song-1";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** ⚠️ Node's Blob, not jsdom's — see the note in lib/audio-store.dom.test.ts:
 *  fake-indexeddb clones every stored value and this environment's structuredClone
 *  turns a jsdom Blob into a bare `{}`. */
const audio = (...bytes: number[]) =>
  new StorableBlob([new Uint8Array(bytes)], { type: "audio/mpeg" }) as unknown as Blob;

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

beforeEach(async () => {
  await deleteDB("cueiq-local-source");
});

describe("setLocalSource → getLocalSource", () => {
  it("round-trips the bytes and the file name", async () => {
    await setLocalSource(SONG, audio(7, 8, 9), "master-from-my-ssd.wav");

    const rec = await getLocalSource(SONG);
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe("master-from-my-ssd.wav");
    expect(await bytesOf(rec!.blob)).toEqual([7, 8, 9]);
  });

  // setAt is bookkeeping, not something playback should see leaking into the shape
  // it hands to the transport.
  it("hands back only the blob and the name", async () => {
    await setLocalSource(SONG, audio(1), "a.wav");
    expect(Object.keys((await getLocalSource(SONG))!).sort()).toEqual(["blob", "name"]);
  });

  it("choosing a second file replaces the first", async () => {
    await setLocalSource(SONG, audio(1), "first.wav");
    await setLocalSource(SONG, audio(2, 2), "second.wav");

    const rec = await getLocalSource(SONG);
    expect(rec!.name).toBe("second.wav");
    expect(await bytesOf(rec!.blob)).toEqual([2, 2]);
    expect(await listLocalSourceIds()).toEqual(new Set([SONG]));
  });

  it("a song with no override reads as null — playback falls back to the master", async () => {
    await setLocalSource("other-song", audio(1), "other.wav");
    expect(await getLocalSource(SONG)).toBeNull();
  });

  // Every playback entry point can hand this an id it does not have yet (a row still
  // loading, a setlist slot with no song linked). It must answer, not open a database.
  it("a missing song id is null, not an error", async () => {
    expect(await getLocalSource(null)).toBeNull();
    expect(await getLocalSource(undefined)).toBeNull();
    expect(await getLocalSource("")).toBeNull();
  });
});

describe("clearLocalSource", () => {
  it("reverts the song to the online master and drops it from the badge list", async () => {
    await setLocalSource(SONG, audio(1), "a.wav");
    await setLocalSource("song-2", audio(2), "b.wav");

    await clearLocalSource(SONG);

    expect(await getLocalSource(SONG)).toBeNull();
    expect(await getLocalSource("song-2")).not.toBeNull();
    expect(await listLocalSourceIds()).toEqual(new Set(["song-2"]));
  });

  it("clearing a song that has no override is a no-op, not a rejection", async () => {
    await expect(clearLocalSource("never-set")).resolves.toBeUndefined();
  });
});

describe("listLocalSourceIds", () => {
  it("is empty before anything is chosen", async () => {
    expect(await listLocalSourceIds()).toEqual(new Set());
  });

  it("reports every song that has an override on this device", async () => {
    await setLocalSource("a", audio(1), "a.wav");
    await setLocalSource("b", audio(2), "b.wav");
    expect(await listLocalSourceIds()).toEqual(new Set(["a", "b"]));
  });
});

describe("with no IndexedDB at all", () => {
  const real = globalThis.indexedDB;
  const kill = () => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
  };
  afterEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = real;
  });

  // The whole point of the try/catch in this module: a device with storage disabled
  // still plays the show off the online master.
  it("a read resolves to 'no override' instead of throwing", async () => {
    kill();
    await expect(getLocalSource(SONG)).resolves.toBeNull();
    await expect(listLocalSourceIds()).resolves.toEqual(new Set());
  });

  // …and the WRITE deliberately does not swallow it. tryQueueAudioUpload needs to
  // know the file was not kept; answering "fine" would promise a local copy that
  // does not exist.
  it("a write surfaces the failure rather than pretending it stored the file", async () => {
    kill();
    await expect(setLocalSource(SONG, audio(1), "a.wav")).rejects.toThrow(/IndexedDB unavailable/);
  });
});
