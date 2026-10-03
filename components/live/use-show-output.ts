"use client";

// Where is this machine's show sound going? The output device's name for the Signal strip,
// whether it is the computer's own speaker, and - the alarm - a change of device while the
// show runs: the USB interface pulled out and macOS / Windows falling back to the laptop's
// speaker, or the picked device vanishing and audio-output-picker.tsx snapping to the default.
// Desktop only (enumerateDevices gives output labels there; the web build has no routing).
import { useEffect, useRef, useState } from "react";
import { classifyOutput, outputLabel, type OutputKind } from "@/lib/live-signal";

export interface ShowOutput {
  label: string | null;
  kind: OutputKind;
  /** the device changed while the show ran: from → to (null until it does) */
  changed: { from: string; to: string; toKind: OutputKind } | null;
  dismiss: () => void;
}

export function useShowOutput(sinkId: string, enabled: boolean, showRunning: boolean): ShowOutput {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [changed, setChanged] = useState<ShowOutput["changed"]>(null);
  const prev = useRef<string | null>(null);
  const prevSink = useRef(sinkId);

  useEffect(() => {
    const md = enabled ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const refresh = async () => {
      try {
        const all = await md.enumerateDevices();
        if (!alive) return;
        setDevices(
          all.filter((d) => d.kind === "audiooutput" && d.deviceId).map((d) => ({ deviceId: d.deviceId, label: d.label }))
        );
      } catch {
        /* no list: no label, no alarm - never a broken show */
      }
    };
    refresh();
    md.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      md.removeEventListener?.("devicechange", refresh);
    };
  }, [enabled]);

  const label = enabled ? outputLabel(sinkId, devices) : null;
  const kind = classifyOutput(label);

  useEffect(() => {
    if (!enabled || !label) return; // a list in flux (a device mid-vanish) says nothing yet
    // The operator picking another device in Live tools is a choice, not an alarm: the
    // device they left is still listed. A vanished one is not (the picker then snaps to the
    // default), and a change with the pick untouched is the OS switching its default.
    // ("" is the system default - always "still there" to leave)
    const picked =
      prevSink.current !== sinkId &&
      (prevSink.current === "" || devices.some((d) => d.deviceId === prevSink.current));
    if (prev.current && prev.current !== label && showRunning && !picked) {
      setChanged({ from: prev.current, to: label, toKind: classifyOutput(label) });
    }
    prev.current = label;
    prevSink.current = sinkId;
  }, [label, sinkId, devices, showRunning, enabled]);

  // a change seen before the show started is not news once it runs, nor after it ends
  useEffect(() => {
    if (!showRunning) setChanged(null);
  }, [showRunning]);

  return { label, kind, changed, dismiss: () => setChanged(null) };
}
