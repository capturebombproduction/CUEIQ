// A file picked in Live Mode (the quick path: no prep in the library) becomes a TEMPORARY
// library song linked to the row. The song is made with the ROW's length - all that is known
// before the file is read - and Live draws the waveform on the FILE's length
// (songs.duration_seconds, lib/song-file-facts.ts). So once the file has landed, its own
// length follows, aimed at that file: an MC backing track of 5:12 in a 2:30 slot is a 5:12
// song, never a 2:30 one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => []),
  deleteAudio: vi.fn(async () => {}),
}));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  uploadEventAudio: async () => {},
  removeEventAudio: async () => {},
}));
// the backing track is 5:12
vi.mock("@/lib/audio", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio")>()),
  detectAudioDuration: async () => 312,
}));
vi.mock("@/lib/song-analysis-browser", () => ({ analyzeAudioFile: async () => null }));

import { LiveMode } from "./live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";
const NEW_SONG = "cccccccc-3333-4333-8333-cccccccccccc";

const MC: SetlistItem = {
  id: "item-1",
  tenant_id: "tenant-1",
  event_id: EVENT_ID,
  kind: "mc",
  title: "MC + backing",
  duration_seconds: 150,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
  sort_order: 1,
  song_id: null,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
};

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      setlist_items: (call) => (call.verb === "select" ? ok([MC]) : ok([{ id: MC.id }])),
      songs: (call) =>
        call.verb === "insert" ? ok({ id: NEW_SONG }) : call.verb === "update" ? ok([{ id: NEW_SONG }]) : ok([]),
      show_authority: ok([]),
    },
  });
  h.supa = supa;
});

describe("LiveMode · a file attached in Live brings its own length", () => {
  it("the temporary song starts at the row's 2:30, then the file's 5:12 follows, aimed at that file", async () => {
    render(
      <LiveMode
        eventId={EVENT_ID}
        groupId={GROUP_ID}
        eventName="Seishin Kakumei One-Man"
        items={[MC]}
        songAudio={{}}
        canEdit={true}
        lastRunSeconds={null}
        lastRunAt={null}
      />
    );
    await act(async () => {});
    fireEvent.click(screen.getByTitle("โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)"));
    const input = document.querySelector('input[type="file"][accept="audio/*"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(["wav"], "backing.wav", { type: "audio/wav" })] } });
    });

    expect(supa.callsTo("songs", "insert")[0].values).toMatchObject({ duration_seconds: 150 });
    await waitFor(() => expect(supa.callsTo("songs", "update")).toHaveLength(2));
    const [point, length] = supa.callsTo("songs", "update");
    const path = (point.values as { audio_path: string }).audio_path;
    expect(path).toContain(NEW_SONG);
    expect(length.values).toEqual({ duration_seconds: 312 });
    expect(length.eq).toEqual({ id: NEW_SONG, audio_path: path });
  });
});
