// คลังเพลง preview playback. Two things are pinned here: the ▶ button and the
// mini-player do what they say (one song at a time, close stops it), and — the
// part that matters on show day — a preview can NEVER outlive the page: leaving
// it by unmount, by a route change, or by pagehide pauses the element and takes
// its src away, so nothing is left sounding when Live Mode or a practice room
// opens on the same device.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const nav = vi.hoisted(() => ({ path: "/library" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));

// The resolver the hook must reuse: per-path override so a test can hold a
// download open (a promise it settles itself) or make it fail. The cancel signal
// each call was given is kept, so "the download itself stopped" is observable.
const blobs = vi.hoisted(() => ({
  calls: [] as string[],
  signals: [] as (AbortSignal | undefined)[],
  special: new Map<string, (signal?: AbortSignal) => Promise<Blob>>(),
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: (path: string, opts?: { signal?: AbortSignal }) => {
    blobs.calls.push(path);
    blobs.signals.push(opts?.signal);
    return (
      blobs.special.get(path)?.(opts?.signal) ??
      Promise.resolve(new Blob(["x"], { type: "audio/wav" }))
    );
  },
  cacheSongBlob: async () => {},
  pruneSupersededSongs: async () => 0,
}));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  setLocalSource: async () => {},
  clearLocalSource: async () => {},
  listLocalSourceIds: async () => new Set<string>(),
}));
vi.mock("@/lib/mgmt-write", () => ({
  listPendingAudioUploads: async () => new Set<string>(),
  dropPendingAudioUpload: async () => {},
  tryQueueAudioUpload: async () => false,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { SongLibrary } from "./song-library";

// ── a media element that behaves enough like one ─────────────────────────────
// jsdom's play/pause do nothing and `paused` is always true. These track which
// elements are sounding, fire the events the hook listens for, and record every
// play() with the src it was made on — that is how "the gesture reached play()"
// and "it stopped" are observable at all.
const media = { sounding: new Set<HTMLMediaElement>(), plays: [] as { el: HTMLMediaElement; src: string | null }[] };
Object.defineProperty(HTMLMediaElement.prototype, "paused", {
  configurable: true,
  get(this: HTMLMediaElement) {
    return !media.sounding.has(this);
  },
});
beforeEach(() => {
  nav.path = "/library";
  blobs.calls = [];
  blobs.signals = [];
  blobs.special.clear();
  toastMock.error.mockClear();
  toastMock.info.mockClear();
  media.sounding.clear();
  media.plays = [];
  HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
    media.plays.push({ el: this, src: this.getAttribute("src") });
    media.sounding.add(this);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  HTMLMediaElement.prototype.pause = vi.fn(function (this: HTMLMediaElement) {
    if (media.sounding.delete(this)) this.dispatchEvent(new Event("pause"));
  });
});

const song = (id: string, title: string, audio_path: string | null): Song =>
  ({
    id,
    tenant_id: "t1",
    group_id: "g1",
    title,
    duration_seconds: 200,
    copyright_status: "cleared",
    audio_path,
  }) as Song;
const songs = [
  song("s1", "Neon Lullaby", "t1/g1/songs/s1-aaaa.wav"),
  song("s2", "I Am Who I Am", "t1/g1/songs/s2-bbbb.wav"),
  song("s3", "No File Yet", null),
];
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

const tree = () => (
  <ConfirmProvider>
    <SongLibrary tenantId="t1" groups={groups} initialSongs={songs} perms={makePerms(null)} />
  </ConfirmProvider>
);
// md+ table AND phone card both render under jsdom (no CSS) — take the first.
const playBtn = (title: string) => screen.getAllByRole("button", { name: `เล่นตัวอย่าง ${title}` })[0];
const player = () => screen.queryByRole("region", { name: "ตัวอย่างเพลง" });
const realPlays = () => media.plays.filter((p) => p.src?.startsWith("blob:"));
const theElement = () => {
  const els = new Set(media.plays.map((p) => p.el));
  expect(els.size).toBe(1); // ONE element for the whole page, ever
  return [...els][0];
};
async function startPlaying(title: string) {
  fireEvent.click(playBtn(title));
  await waitFor(() => expect(screen.getAllByRole("button", { name: `หยุดตัวอย่าง ${title}` }).length).toBeGreaterThan(0));
}

describe("SongLibrary — preview playback", () => {
  it("offers ▶ only on songs that have a file, on both the table and the phone card", () => {
    render(tree());
    expect(screen.getAllByRole("button", { name: "เล่นตัวอย่าง Neon Lullaby" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "เล่นตัวอย่าง I Am Who I Am" })).toHaveLength(2);
    expect(screen.queryAllByRole("button", { name: /ตัวอย่าง No File Yet/ })).toHaveLength(0);
    expect(player()).toBeNull();
  });

  it("a tap primes the element INSIDE the gesture, then plays the song's bytes and opens the mini-player", async () => {
    render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    // Synchronous, still inside the tap: WebKit only lets an element play later
    // if it played within a gesture — the bytes arrive after awaits.
    expect(media.plays).toHaveLength(1);
    expect(media.plays[0].src).toMatch(/^data:audio\/wav/);
    expect(within(player()!).getByText("Neon Lullaby")).toBeTruthy();

    await waitFor(() => expect(realPlays()).toHaveLength(1));
    expect(blobs.calls).toEqual(["t1/g1/songs/s1-aaaa.wav"]);
    theElement();
    await waitFor(() =>
      expect(within(player()!).getByRole("button", { name: "หยุดชั่วคราว" })).toBeTruthy()
    );
    // the row being heard is marked, on the table and on the card
    const marked = document.querySelectorAll('[aria-current="true"][data-playing="true"]');
    expect(marked).toHaveLength(2);
    marked.forEach((el) => expect(el.textContent).toContain("Neon Lullaby"));
  });

  it("tapping another song switches to it — one song at a time, one element", async () => {
    render(tree());
    await startPlaying("Neon Lullaby");
    const first = realPlays()[0].src;

    fireEvent.click(playBtn("I Am Who I Am"));
    await waitFor(() => expect(realPlays()).toHaveLength(2));
    const el = theElement();
    expect(el.getAttribute("src")).toBe(realPlays()[1].src);
    expect(realPlays()[1].src).not.toBe(first);
    expect(blobs.calls).toEqual(["t1/g1/songs/s1-aaaa.wav", "t1/g1/songs/s2-bbbb.wav"]);
    expect(within(player()!).getByText("I Am Who I Am")).toBeTruthy();
    expect(within(player()!).queryByText("Neon Lullaby")).toBeNull();
    // the first song is back to a plain ▶ and no longer marked
    expect(screen.getAllByRole("button", { name: "เล่นตัวอย่าง Neon Lullaby" })).toHaveLength(2);
    const marked = document.querySelectorAll('[aria-current="true"]');
    expect(marked).toHaveLength(2);
    marked.forEach((m) => expect(m.textContent).toContain("I Am Who I Am"));
  });

  it("tapping the song that is playing pauses it; tapping again resumes", async () => {
    render(tree());
    await startPlaying("Neon Lullaby");
    const el = theElement();
    fireEvent.click(screen.getAllByRole("button", { name: "หยุดตัวอย่าง Neon Lullaby" })[0]);
    expect(el.paused).toBe(true);
    expect(within(player()!).getByRole("button", { name: "เล่นต่อ" })).toBeTruthy();
    fireEvent.click(playBtn("Neon Lullaby"));
    expect(el.paused).toBe(false); // synchronous: the tap's own gesture plays it
    expect(blobs.calls).toHaveLength(1); // same song — not fetched again
  });

  it("close stops: paused, src gone, mini-player gone", async () => {
    render(tree());
    await startPlaying("Neon Lullaby");
    const el = theElement();
    fireEvent.click(within(player()!).getByRole("button", { name: "ปิดตัวเล่น" }));
    expect(el.paused).toBe(true);
    expect(el.hasAttribute("src")).toBe(false);
    expect(player()).toBeNull();
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  it("unmounting the page pauses the element and clears its src", async () => {
    const { unmount } = render(tree());
    await startPlaying("Neon Lullaby");
    const el = theElement();
    expect(el.paused).toBe(false);
    unmount();
    expect(el.paused).toBe(true);
    expect(el.hasAttribute("src")).toBe(false);
  });

  it("a route change stops it even if the page stayed mounted", async () => {
    const { rerender } = render(tree());
    await startPlaying("Neon Lullaby");
    const el = theElement();
    nav.path = "/events/e1/live";
    rerender(tree());
    expect(el.paused).toBe(true);
    expect(el.hasAttribute("src")).toBe(false);
    expect(player()).toBeNull();
  });

  it("pagehide stops it", async () => {
    render(tree());
    await startPlaying("Neon Lullaby");
    const el = theElement();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(el.paused).toBe(true);
    expect(el.hasAttribute("src")).toBe(false);
    expect(player()).toBeNull();
  });

  it("a download that lands AFTER the page is gone never starts playing", async () => {
    let land!: (b: Blob) => void;
    blobs.special.set(
      "t1/g1/songs/s1-aaaa.wav",
      () => new Promise<Blob>((r) => (land = r))
    );
    const { unmount } = render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() => expect(blobs.calls).toHaveLength(1));
    unmount();
    await act(async () => land(new Blob(["x"], { type: "audio/wav" })));
    expect(realPlays()).toHaveLength(0);
    expect(media.sounding.size).toBe(0);
  });

  it("a failed load says so in Thai and closes the player", async () => {
    blobs.special.set("t1/g1/songs/s1-aaaa.wav", () =>
      Promise.reject(new Error("ดาวน์โหลดไฟล์เสียงไม่สำเร็จ (503)"))
    );
    render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "เล่นตัวอย่างไม่สำเร็จ",
        expect.objectContaining({ description: "ดาวน์โหลดไฟล์เสียงไม่สำเร็จ (503)" })
      )
    );
    expect(player()).toBeNull();
    expect(realPlays()).toHaveLength(0);
  });

  // lib/audio-remote gives up on a stalled presign / byte stream with a bare
  // abort(), so a dead venue link reaches the hook as a DOMException AbortError —
  // the same NAME as play() being interrupted. Treated as harmless, it left the
  // player open with nothing loaded: ▶ did nothing and nothing said why.
  it("a download that gives up (AbortError) says so in Thai and closes — no dead ▶", async () => {
    blobs.special.set("t1/g1/songs/s1-aaaa.wav", () =>
      Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
    );
    render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "เล่นตัวอย่างไม่สำเร็จ",
        expect.objectContaining({ description: "เน็ตช้าหรือหลุด — ลองใหม่อีกครั้ง" })
      )
    );
    expect(player()).toBeNull();
    expect(realPlays()).toHaveLength(0);
    // the row's ▶ is a live ▶ again: the next tap tries the download afresh
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() => expect(blobs.calls).toHaveLength(2));
  });

  it("an AbortError from the element's own play() is only an interruption — loaded, paused, ▶ works", async () => {
    const play = HTMLMediaElement.prototype.play;
    let interrupted = false;
    HTMLMediaElement.prototype.play = vi.fn(function (this: HTMLMediaElement) {
      const src = this.getAttribute("src");
      if (!interrupted && src?.startsWith("blob:")) {
        interrupted = true;
        return Promise.reject(new DOMException("interrupted by pause()", "AbortError"));
      }
      return play.call(this);
    });
    render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() =>
      expect(within(player()!).getByRole("button", { name: "เล่นต่อ" })).toBeTruthy()
    );
    expect(toastMock.error).not.toHaveBeenCalled();
    fireEvent.click(within(player()!).getByRole("button", { name: "เล่นต่อ" }));
    expect(realPlays()).toHaveLength(1);
    expect(theElement().paused).toBe(false);
  });

  // A download that never lands on its own and, like a real fetch, rejects with an
  // AbortError the moment its signal fires.
  const hangUntilAborted = (signal?: AbortSignal) =>
    new Promise<Blob>((_, reject) =>
      signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError"))
      )
    );

  it.each([
    ["✕ in the mini-player", () => fireEvent.click(within(player()!).getByRole("button", { name: "ปิดตัวเล่น" }))],
    ["ยกเลิก while loading", () => fireEvent.click(within(player()!).getByRole("button", { name: "ยกเลิก" }))],
    ["pagehide", () => act(() => void window.dispatchEvent(new Event("pagehide")))],
  ])("%s cancels the download itself, not just the UI — quietly", async (_, leave) => {
    blobs.special.set("t1/g1/songs/s1-aaaa.wav", hangUntilAborted);
    render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() => expect(blobs.signals).toHaveLength(1));
    const signal = blobs.signals[0]!;
    expect(signal.aborted).toBe(false);
    leave();
    expect(signal.aborted).toBe(true);
    await act(async () => {}); // let the aborted download's rejection settle
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(player()).toBeNull();
  });

  it("leaving the page mid-download cancels the download", async () => {
    blobs.special.set("t1/g1/songs/s1-aaaa.wav", hangUntilAborted);
    const { unmount } = render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() => expect(blobs.signals).toHaveLength(1));
    unmount();
    expect(blobs.signals[0]!.aborted).toBe(true);
  });

  it("switching songs mid-download cancels the first download, not the new one", async () => {
    blobs.special.set("t1/g1/songs/s1-aaaa.wav", hangUntilAborted);
    render(tree());
    fireEvent.click(playBtn("Neon Lullaby"));
    await waitFor(() => expect(blobs.signals).toHaveLength(1));
    fireEvent.click(playBtn("I Am Who I Am"));
    expect(blobs.signals[0]!.aborted).toBe(true);
    await waitFor(() => expect(realPlays()).toHaveLength(1));
    expect(blobs.signals[1]!.aborted).toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(within(player()!).getByText("I Am Who I Am")).toBeTruthy();
  });
});
