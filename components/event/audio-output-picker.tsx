"use client";

import { useEffect, useRef, useState } from "react";
import { Speaker } from "lucide-react";
import { toast } from "sonner";

/** Where the saved output-device choice lives (per device, survives restarts). */
export const AUDIO_SINK_KEY = "cueiq:audioSink";

/** The device the operator PICKED, kept while the show falls back to the default
 *  because it is unplugged - the show's own key then holds "" (see the picker). */
const WANTED_SINK_KEY = "cueiq:audioSinkWanted";

/** The saved output deviceId ("" = system default) - the picked one, even while it
 *  is unplugged, so a restart with the cable out still knows where the show goes. */
export function loadAudioSink(): string {
  try {
    return localStorage.getItem(AUDIO_SINK_KEY) || localStorage.getItem(WANTED_SINK_KEY) || "";
  } catch {
    return "";
  }
}

function loadWantedSink(): string {
  try {
    return localStorage.getItem(WANTED_SINK_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveWantedSink(id: string) {
  try {
    if (id) localStorage.setItem(WANTED_SINK_KEY, id);
    else localStorage.removeItem(WANTED_SINK_KEY);
  } catch {
    /* ignore */
  }
}

interface OutputDevice {
  deviceId: string;
  label: string;
}

async function listOutputs(): Promise<OutputDevice[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default")
      .map((d) => ({ deviceId: d.deviceId, label: d.label || "อุปกรณ์เสียง" }));
  } catch {
    return [];
  }
}

/**
 * Output-device lock for the show (DESKTOP only — the standalone show machine).
 * Live Mode plays through whatever Windows/macOS currently calls the "default"
 * output, so a Bluetooth headset or an HDMI screen connecting mid-show can
 * silently steal the PA feed (usually the MacBook's 3.5mm jack at idol shows).
 * Picking a device here pins the show audio to it via setSinkId; the default
 * option keeps today's behavior exactly. Hidden on the web build — the desktop
 * app is the machine that makes sound.
 *
 * If the chosen device disappears (cable pulled), the parent falls back to the
 * system default and keeps playing — the show must never go silent over routing.
 */
export function AudioOutputPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
}) {
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const isDesktop =
    typeof window !== "undefined" &&
    !!(window as { cueiqNative?: unknown }).cueiqNative;

  useEffect(() => {
    if (!isDesktop) return;
    let alive = true;
    const refresh = async () => {
      const outs = await listOutputs();
      if (alive) setDevices(outs);
    };
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [isDesktop]);

  // The device the operator picked. A fallback to the default (below) leaves it
  // here, so the show goes BACK to the interface when it is plugged in again - it
  // used to be forgotten: a re-seated USB cable left the rest of the show (and the
  // next one) on the laptop speaker, under a DEVICE LOST alarm re-plugging never cleared.
  // Seeded from storage too: a picker mounted while the show is already on the fallback
  // (the tools panel reopened with the cable still out) knew nothing to go back to
  // (2026-10-26, ตาที่ 3).
  const wantedRef = useRef(value || loadWantedSink());
  useEffect(() => {
    if (value) wantedRef.current = value;
  }, [value]);

  // The saved device vanished (USB/adapter unplugged) → snap back to the system
  // default so the audio keeps coming out SOMEWHERE, and say so.
  useEffect(() => {
    if (!isDesktop || devices.length === 0) return;
    if (value && !devices.some((d) => d.deviceId === value)) {
      wantedRef.current = value;
      saveWantedSink(value);
      onChange("");
      toast.warning("อุปกรณ์เสียงที่เลือกไว้ถูกถอดออก", {
        description: "สลับกลับไปใช้ลำโพงเริ่มต้นของระบบ เสียงยังออกต่อเนื่อง — เสียบกลับแล้วจะกลับไปออกที่เดิมเอง",
      });
      return;
    }
    const wanted = wantedRef.current;
    const back = !value && wanted ? devices.find((d) => d.deviceId === wanted) : undefined;
    if (back) {
      onChange(wanted);
      toast.success(`เสียงกลับไปออกที่ ${back.label}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, value, isDesktop]);

  function pick(id: string) {
    wantedRef.current = id; // "" = the operator chose the default: nothing to go back to
    saveWantedSink(id);
    onChange(id);
  }

  if (!isDesktop) return null;

  return (
    <label className="flex h-11 w-full min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
      <Speaker aria-hidden className="size-4 shrink-0" />
      <span className="shrink-0">เสียงออกที่</span>
      <select
        value={value}
        onChange={(e) => pick(e.target.value)}
        disabled={disabled}
        title="ล็อกเสียงโชว์ให้ออกอุปกรณ์นี้ (กันเสียงโดน Bluetooth/HDMI แย่งกลางโชว์)"
        className="h-11 min-w-0 flex-1 truncate rounded-[3px] bg-card px-2.5 text-[14px] text-foreground shadow-[inset_0_0_0_1.5px_hsl(var(--input))] focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] disabled:opacity-50"
      >
        <option value="">ลำโพงเริ่มต้นของระบบ</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
}
