// The web Library reads its cover pictures in the browser (components/song/library-covers.ts):
// sent with the page they were ~1.1 MB of its HTML (each ~10 K data URL three times - two
// <img>s and the RSC payload). These pin what the move must not change: every cover still
// drawn, each read once per visit, a cover changed elsewhere still arrives with a refresh,
// and a failed / hanging / anon read leaves the band tile instead of a grey box.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { makePerms } from "@/lib/permissions";
import type { Group, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  covers: {} as Record<string, string | null>,
  reads: [] as { columns: string; ids: string[] }[],
  answer: "ok" as "ok" | "error" | "hang" | "empty",
  live: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/library",
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: async () => null,
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
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => h.live }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: (columns: string) => ({
        in: (_col: string, ids: string[]) => {
          h.reads.push({ columns, ids: [...ids].sort() });
          if (h.answer === "hang") return new Promise(() => {});
          if (h.answer === "error") return Promise.resolve({ data: null, error: { message: "boom" } });
          if (h.answer === "empty") return Promise.resolve({ data: [], error: null });
          return Promise.resolve({
            data: ids.filter((id) => id in h.covers).map((id) => ({ id, cover: h.covers[id] })),
            error: null,
          });
        },
      }),
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { SongLibrary } from "./song-library";
import { COVER_WAIT_MS, resetLibraryCoverCache } from "./library-covers";

const A = "data:image/webp;base64,QUFB";
const B = "data:image/webp;base64,QkJC";
const A2 = "data:image/webp;base64,QTIy";
// rows as the web page now reads them: no `cover` key at all
const row = (id: string, title: string, updated_at = "2026-11-01T00:00:00+00:00"): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 200, copyright_status: "cleared", audio_path: null, updated_at }) as Song;
const groups = [{ id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group];

const ui = (songs: Song[], lazy = true) => (
  <ConfirmProvider>
    <SongLibrary tenantId="t1" groups={groups} initialSongs={songs} perms={makePerms("admin")} lazyCovers={lazy} />
  </ConfirmProvider>
);
// every <img> the phone list and the desktop table draw, by src
const imgs = () => Array.from(document.querySelectorAll("img")).map((i) => i.getAttribute("src"));

beforeEach(() => {
  document.body.innerHTML = "";
  resetLibraryCoverCache();
  h.covers = { s1: A, s2: B, s3: null };
  h.reads.length = 0;
  h.answer = "ok";
  h.live = true;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Library covers read in the browser", () => {
  it("draws every cover from ONE read of id + cover, in both the table and the phone list", async () => {
    render(ui([row("s1", "Alpha"), row("s2", "Beta"), row("s3", "Gamma")]));
    await waitFor(() => expect(imgs().filter((s) => s === A)).toHaveLength(2));
    expect(imgs().filter((s) => s === B)).toHaveLength(2);
    expect(imgs()).toHaveLength(4); // s3 has none: its band tile, no <img>
    expect(h.reads).toEqual([{ columns: "id, cover", ids: ["s1", "s2", "s3"] }]);
  });

  it("asks nothing again on a second visit in the same session", async () => {
    const songs = [row("s1", "Alpha"), row("s2", "Beta")];
    const first = render(ui(songs));
    await waitFor(() => expect(imgs().filter((s) => s === A)).toHaveLength(2));
    first.unmount();
    render(ui(songs));
    expect(imgs().filter((s) => s === A)).toHaveLength(2); // at once, from the visit's map
    expect(h.reads).toHaveLength(1);
  });

  it("a newer row (a cover changed on another device) reads that song again, showing the old one meanwhile", async () => {
    const view = render(ui([row("s1", "Alpha"), row("s2", "Beta")]));
    await waitFor(() => expect(imgs().filter((s) => s === A)).toHaveLength(2));
    h.covers.s1 = A2;
    // the re-read held open: what shows meanwhile is the cover the visit already had
    h.answer = "hang";
    view.rerender(ui([row("s1", "Alpha", "2026-11-05T00:00:00+00:00"), row("s2", "Beta")]));
    expect(imgs().filter((s) => s === A)).toHaveLength(2); // the old cover, not a grey box
    expect(h.reads[1]).toEqual({ columns: "id, cover", ids: ["s1"] }); // only the changed song
    // the next version (another refresh) reads again and draws the new cover
    h.answer = "ok";
    view.rerender(ui([row("s1", "Alpha", "2026-11-05T00:00:01+00:00"), row("s2", "Beta")]));
    await waitFor(() => expect(imgs().filter((s) => s === A2)).toHaveLength(2));
    expect(imgs().filter((s) => s === B)).toHaveLength(2);
  });

  it("after a cover is changed here, the refresh shows the NEW cover while it re-reads, never the old one", async () => {
    const view = render(ui([row("s1", "Alpha")]));
    await waitFor(() => expect(imgs().filter((s) => s === A)).toHaveLength(2));
    // saveCover puts the new picture on the row in state
    view.rerender(ui([{ ...row("s1", "Alpha"), cover: A2 }]));
    expect(imgs().filter((s) => s === A2)).toHaveLength(2);
    // the save bar's router.refresh: the row comes back newer, without `cover`; its read hangs
    h.answer = "hang";
    view.rerender(ui([row("s1", "Alpha", "2026-11-05T00:00:00+00:00")]));
    expect(imgs().filter((s) => s === A2)).toHaveLength(2);
    expect(imgs().filter((s) => s === A)).toHaveLength(0);
  });

  it("a failed read leaves the band tiles, not grey boxes", async () => {
    h.answer = "error";
    render(ui([row("s1", "Alpha")]));
    await waitFor(() => expect(document.querySelectorAll("span.bg-muted.h-11")).toHaveLength(0));
    expect(imgs()).toHaveLength(0);
    expect(h.reads).toHaveLength(1);
  });

  it("an empty answer with no live session (an anon read) is not taken as 'no covers'", async () => {
    h.answer = "empty";
    h.live = false;
    const songs = [row("s1", "Alpha")];
    const first = render(ui(songs));
    await waitFor(() => expect(document.querySelectorAll("span.bg-muted.h-11")).toHaveLength(0));
    first.unmount();
    // nothing was remembered as "none": the next version of the row asks again and gets it
    h.answer = "ok";
    h.live = true;
    render(ui([row("s1", "Alpha", "2026-11-05T00:00:00+00:00")]));
    await waitFor(() => expect(imgs().filter((s) => s === A)).toHaveLength(2));
  });

  it("a read that hangs shows the band tiles after COVER_WAIT_MS", async () => {
    vi.useFakeTimers();
    h.answer = "hang";
    render(ui([row("s1", "Alpha")]));
    expect(document.querySelectorAll("span.bg-muted.h-11").length).toBeGreaterThan(0); // the neutral frame
    await act(async () => {
      vi.advanceTimersByTime(COVER_WAIT_MS + 1);
    });
    expect(document.querySelectorAll("span.bg-muted.h-11")).toHaveLength(0);
    expect(imgs()).toHaveLength(0);
  });

  it("off (the desktop): draws each row's own cover and reads nothing", async () => {
    render(ui([{ ...row("s1", "Alpha"), cover: A }, row("s2", "Beta")], false));
    expect(imgs().filter((s) => s === A)).toHaveLength(2);
    expect(imgs()).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reads).toHaveLength(0);
  });

  it("a row that carries its cover (a save's answer) is drawn from the row", async () => {
    render(ui([{ ...row("s1", "Alpha"), cover: B }]));
    expect(imgs().filter((s) => s === B)).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.reads).toHaveLength(0);
  });
});
