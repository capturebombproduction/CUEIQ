// components/live/use-show-output.ts - the DEVICE LOST alarm. It must fire when the show's
// sound really moved (the OS fell back to the laptop speaker; the picked interface vanished)
// and must NOT fire when the operator picks another output on purpose, or before / after a show.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useShowOutput } from "./use-show-output";

type Dev = { kind: string; deviceId: string; label: string };
let devices: Dev[] = [];
let listeners: (() => void)[] = [];
const usb = { kind: "audiooutput", deviceId: "usb-1", label: "USB Audio CODEC" };
const mac = { kind: "audiooutput", deviceId: "mac-1", label: "MacBook Pro Speakers" };
const defaultIs = (d: Dev) => ({ kind: "audiooutput", deviceId: "default", label: `Default - ${d.label}` });
const replug = async (next: Dev[]) => {
  devices = next;
  await act(async () => listeners.forEach((l) => l()));
};

beforeEach(() => {
  devices = [defaultIs(usb), usb, mac];
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

describe("useShowOutput", () => {
  it("names where the sound goes and whether it is the computer's own speaker", async () => {
    const { result, rerender } = renderHook(({ sink }) => useShowOutput(sink, true, false), { initialProps: { sink: "" } });
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    expect(result.current.kind).toBe("external");
    rerender({ sink: "mac-1" });
    expect(result.current.label).toBe("MacBook Pro Speakers");
    expect(result.current.kind).toBe("builtin");
  });

  it("alarms when the OS switches the default mid-show (the interface was pulled)", async () => {
    const { result } = renderHook(() => useShowOutput("", true, true));
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    await replug([defaultIs(mac), mac]);
    await waitFor(() =>
      expect(result.current.changed).toEqual({ from: "USB Audio CODEC", to: "MacBook Pro Speakers", toKind: "builtin" })
    );
    act(() => result.current.dismiss());
    expect(result.current.changed).toBeNull();
  });

  it("alarms when the PICKED device vanishes and the picker snaps to the default", async () => {
    const { result, rerender } = renderHook(({ sink }) => useShowOutput(sink, true, true), {
      initialProps: { sink: "usb-1" },
    });
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    await replug([defaultIs(mac), mac]); // the interface is gone: no label for usb-1 at all
    expect(result.current.changed).toBeNull(); // a list in flux says nothing yet
    rerender({ sink: "" }); // audio-output-picker.tsx's fallback
    await waitFor(() => expect(result.current.changed?.to).toBe("MacBook Pro Speakers"));
    expect(result.current.changed?.from).toBe("USB Audio CODEC");
  });

  it("does NOT alarm when the operator picks another output on purpose - from a device or from the default", async () => {
    const { result, rerender } = renderHook(({ sink }) => useShowOutput(sink, true, true), {
      initialProps: { sink: "usb-1" },
    });
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    rerender({ sink: "mac-1" });
    expect(result.current.label).toBe("MacBook Pro Speakers");
    expect(result.current.changed).toBeNull();
    rerender({ sink: "" }); // back to the system default (still the USB interface)
    rerender({ sink: "usb-1" }); // and from the default to a device
    expect(result.current.changed).toBeNull();
  });

  it("is quiet when no show runs, and a show ending clears what it said", async () => {
    const { result, rerender } = renderHook(({ running }) => useShowOutput("", true, running), {
      initialProps: { running: false },
    });
    await waitFor(() => expect(result.current.label).toBe("USB Audio CODEC"));
    await replug([defaultIs(mac), mac]);
    await waitFor(() => expect(result.current.label).toBe("MacBook Pro Speakers"));
    expect(result.current.changed).toBeNull();
    rerender({ running: true });
    await replug([defaultIs(usb), usb, mac]);
    await waitFor(() => expect(result.current.changed).not.toBeNull());
    rerender({ running: false });
    expect(result.current.changed).toBeNull();
  });

  it("off the desktop app it asks nothing and says nothing", async () => {
    const { result } = renderHook(() => useShowOutput("", false, true));
    await replug([defaultIs(mac), mac]);
    expect(result.current.label).toBeNull();
    expect(result.current.changed).toBeNull();
  });
});
