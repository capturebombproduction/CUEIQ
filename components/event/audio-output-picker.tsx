"use client";

import { useEffect, useState } from "react";
import { Speaker } from "lucide-react";
import { toast } from "sonner";

/** Where the saved output-device choice lives (per device, survives restarts). */
export const AUDIO_SINK_KEY = "cueiq:audioSink";

/** The saved output deviceId ("" = system default). */
export function loadAudioSink(): string {
  try {
    return localStorage.getItem(AUDIO_SINK_KEY) ?? "";
  } catch {
    return "";
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

  // The saved device vanished (USB/adapter unplugged) → snap back to the system
  // default so the audio keeps coming out SOMEWHERE, and say so.
  useEffect(() => {
    if (!isDesktop || !value || devices.length === 0) return;
    if (!devices.some((d) => d.deviceId === value)) {
      onChange("");
      toast.warning("อุปกรณ์เสียงที่เลือกไว้ถูกถอดออก", {
        description: "สลับกลับไปใช้ลำโพงเริ่มต้นของระบบ เสียงยังออกต่อเนื่อง",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, value, isDesktop]);

  if (!isDesktop) return null;

  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
      <Speaker className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0">เสียงออกที่</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title="ล็อกเสียงโชว์ให้ออกอุปกรณ์นี้ (กันเสียงโดน Bluetooth/HDMI แย่งกลางโชว์)"
        className="h-7 min-w-0 flex-1 truncate rounded-md border bg-background px-1.5 text-xs text-foreground disabled:opacity-50"
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
