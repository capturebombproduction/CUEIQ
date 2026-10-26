// The output picker takes the show back to the interface it was set to once it is
// plugged in again (2026-10-26) - also when the picker itself was mounted while the
// show was already on the fallback (the tools panel reopened with the cable still out):
// it used to know only its `value` prop, "" by then, and nothing went back (ตาที่ 3).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

import { AudioOutputPicker, AUDIO_SINK_KEY, loadAudioSink } from "@/components/event/audio-output-picker";

let outputs: { deviceId: string; kind: string; label: string }[];
let md: EventTarget & { enumerateDevices: () => Promise<unknown[]> };

beforeEach(() => {
  localStorage.clear();
  outputs = [{ deviceId: "builtin-1", kind: "audiooutput", label: "MacBook Pro Speakers" }];
  md = Object.assign(new EventTarget(), { enumerateDevices: async () => outputs.map((d) => ({ ...d })) });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: md });
  (window as unknown as { cueiqNative?: unknown }).cueiqNative = {};
});
afterEach(() => {
  cleanup();
  delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
});

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("AudioOutputPicker", () => {
  it("a picker mounted on the fallback still takes the show back when the interface returns", async () => {
    // an earlier picker saw the interface vanish: the show's key holds "", the pick is kept
    localStorage.setItem(AUDIO_SINK_KEY, "");
    localStorage.setItem("cueiq:audioSinkWanted", "usb-1");
    expect(loadAudioSink()).toBe("usb-1"); // a restart with the cable out knows the pick too
    const onChange = vi.fn();
    render(<AudioOutputPicker value="" onChange={onChange} />);
    await settle();
    expect(onChange).not.toHaveBeenCalled(); // still unplugged

    outputs = [...outputs, { deviceId: "usb-1", kind: "audiooutput", label: "USB Audio Interface" }];
    await act(async () => {
      md.dispatchEvent(new Event("devicechange"));
    });
    await settle();
    expect(onChange).toHaveBeenCalledWith("usb-1");
  });

  it("choosing the system default on purpose leaves nothing to go back to", async () => {
    localStorage.setItem("cueiq:audioSinkWanted", "usb-1");
    outputs = [...outputs, { deviceId: "usb-1", kind: "audiooutput", label: "USB Audio Interface" }];
    const onChange = vi.fn();
    const { container } = render(<AudioOutputPicker value="usb-1" onChange={onChange} />);
    await settle();
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(localStorage.getItem("cueiq:audioSinkWanted")).toBeNull();
  });
});
