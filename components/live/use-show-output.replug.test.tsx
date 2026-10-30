// 2026-10-30, hunt 12: the interface pulled and re-seated. The picker sent the sound back and said
// so, while the red band on the NOW card still read "Device lost · ตอนนี้ออก Speakers" until someone
// pressed ปิด - and an operator could go and re-patch what was already fine.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useShowOutput } from "./use-show-output";

type Dev = { kind: string; deviceId: string; label: string };
let devices: Dev[] = [];
let listeners: (() => void)[] = [];
const usb = { kind: "audiooutput", deviceId: "usb-1", label: "USB Audio CODEC" };
const spk = { kind: "audiooutput", deviceId: "spk-1", label: "Speakers (Realtek(R) Audio)" };
const defaultIs = (d: Dev) => ({ kind: "audiooutput", deviceId: "default", label: `Default - ${d.label}` });
const replug = async (next: Dev[]) => {
  devices = next;
  await act(async () => listeners.forEach((l) => l()));
};

beforeEach(() => {
  devices = [defaultIs(spk), spk, usb];
  listeners = [];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => devices,
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      removeEventListener: (_: string, l: () => void) => (listeners = listeners.filter((x) => x !== l)),
    },
  });
});
afterEach(() => {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe("useShowOutput · the alarm after a re-plug", () => {
  it("a picked interface: the alarm goes when the picker has it back", async () => {
    const { result, rerender } = renderHook(({ sink }) => useShowOutput(sink, true, true), {
      initialProps: { sink: "usb-1" },
    });
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    await replug([defaultIs(spk), spk]); // pulled
    rerender({ sink: "" }); // the picker falls to the default
    await waitFor(() => expect(result.current.changed?.toKind).toBe("builtin"));
    await replug([defaultIs(spk), spk, usb]); // back
    rerender({ sink: "usb-1" }); // the picker routes back
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    expect(result.current.changed).toBeNull();
  });

  it("the OS default: going back does not raise a second alarm, it ends the first", async () => {
    devices = [defaultIs(usb), usb, spk];
    const { result } = renderHook(() => useShowOutput("", true, true));
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    await replug([defaultIs(spk), spk]);
    await waitFor(() => expect(result.current.changed?.to).toBe("Speakers (Realtek(R) Audio)"));
    await replug([defaultIs(usb), usb, spk]);
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    expect(result.current.changed).toBeNull();
  });

  it("a move to a third device is still an alarm", async () => {
    const hdmi = { kind: "audiooutput", deviceId: "hdmi", label: "HDMI TV" };
    devices = [defaultIs(usb), usb, spk];
    const { result } = renderHook(() => useShowOutput("", true, true));
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    await replug([defaultIs(spk), spk]);
    await waitFor(() => expect(result.current.changed?.to).toBe("Speakers (Realtek(R) Audio)"));
    await replug([defaultIs(hdmi), hdmi, spk]);
    await waitFor(() => expect(result.current.changed?.to).toBe("HDMI TV"));
  });
});
