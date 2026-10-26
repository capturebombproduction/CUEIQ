// A report still on its way when the Feedback tile remounts (2026-10-27, hunt 6).
//
// The draft lived in the shell's FeedbackUnreadProvider (it outlives the tile), but
// the "sending" flag lived in the tile. The dialog invites closing mid-send
// ("ปิดหน้าต่าง") and the More sheet unmounts the tile on close, so the tile reopened
// while the first send was still uploading its screenshot showed the same text with
// ส่ง enabled: pressed again, the report was filed twice, and anything typed meanwhile
// was wiped by the first send's success.
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  release: null as null | (() => void),
  upload: vi.fn<(key: string, f: File | Blob, contentType?: string) => Promise<void>>(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, uploadEventAudio: h.upload };
});

import { FeedbackButton, FeedbackUnreadProvider } from "@/components/feedback-button";

const TENANT = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

let supa: SupabaseFake;
let toggleSheet: () => void = () => {};

/** The shell: one provider for the session, the tile inside a sheet that comes and goes. */
function Shell() {
  const [sheet, setSheet] = useState(true);
  toggleSheet = () => setSheet((s) => !s);
  return (
    <FeedbackUnreadProvider userId={ME}>
      {sheet && <FeedbackButton userId={ME} tenantId={TENANT} />}
    </FeedbackUnreadProvider>
  );
}

const openTile = () => fireEvent.click(screen.getByTitle(/แจ้งปัญหา|มีคำตอบ/));
const box = () => screen.getByLabelText("รายละเอียด") as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "ส่ง" }) as HTMLButtonElement;
const inserts = () => supa.calls.filter((c) => c.table === "feedback" && c.verb === "insert");

beforeEach(() => {
  h.upload.mockReset();
  // the screenshot upload hangs until the test lets it land
  h.upload.mockImplementation(() => new Promise<void>((res) => (h.release = res)));
  if (!("createObjectURL" in URL)) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", writable: true });
  }
  if (!("revokeObjectURL" in URL)) {
    Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, writable: true });
  }
  supa = makeSupabaseFake({ script: { feedback: ok([]) } });
  h.supa = supa;
});
afterEach(() => cleanup());

describe("a feedback send still in flight when the tile remounts", () => {
  it("the reopened tile shows it as sending: no second ส่ง, nothing to type over", async () => {
    render(<Shell />);
    openTile();
    fireEvent.change(box(), { target: { value: "เสียงไม่เล่นตอนกด GO" } });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File([new Uint8Array(10)], "shot.png", { type: "image/png" })] },
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));

    // "ปิดหน้าต่าง", back to the show: the More sheet closes, then opens again
    fireEvent.click(screen.getByRole("button", { name: "ปิดหน้าต่าง" }));
    act(() => toggleSheet());
    act(() => toggleSheet());
    openTile();

    expect(box().value).toBe("เสียงไม่เล่นตอนกด GO");
    expect(sendButton().disabled).toBe(true);
    expect(box().disabled).toBe(true);

    // the first send lands: one report, the box empties and the tile is free again
    await act(async () => h.release?.());
    await waitFor(() => expect(inserts()).toHaveLength(1));
    await waitFor(() => expect(box().value).toBe(""));
    expect(box().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
  });
});
