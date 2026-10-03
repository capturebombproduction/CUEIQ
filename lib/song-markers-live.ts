"use client";

// The practice room's section markers (song_markers, 0023: "INTRO", "CHORUS", ... at a time
// in the song), for Live Mode's NOW card: the waveform's section labels and the line under it,
// "ท่อน VERSE 1 · ถัดไป CHORUS ใน 0:12".
//
// Decoration, built so it can never get in a show's way (the same rules as song-covers.ts):
// one read per new set of songs, never awaited; a failed read leaves no labels. Unlike covers
// the answers are kept on the device too (a few hundred bytes per song), so a desktop that saw
// them online still has them at an offline venue.

import { useEffect, useMemo, useState } from "react";
// Absolute path so the desktop build's "@/lib/supabase/client" alias applies.
import { createClient } from "@/lib/supabase/client";

import type { LiveMarker } from "@/lib/song-signal";
export type { LiveMarker };

const STORE_KEY = "cueiq:songMarkers:v1";
const known = new Map<string, LiveMarker[]>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
let loaded = false;

function loadStore() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORE_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as Record<string, LiveMarker[]>) : {};
    for (const [id, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) known.set(id, list.filter((m) => typeof m?.label === "string" && Number.isFinite(m?.at)));
    }
  } catch {
    /* a bad store is no store */
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(known)));
  } catch {
    /* full or blocked: the markers just are not kept for offline */
  }
}

/** For tests: forget everything, on disk too. */
export function resetSongMarkerCache(): void {
  known.clear();
  asking.clear();
  listeners.clear();
  loaded = false;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* nothing to forget */
  }
}

function snapshot(ids: string[]): Record<string, LiveMarker[]> {
  const out: Record<string, LiveMarker[]> = {};
  for (const id of ids) {
    const m = known.get(id);
    if (m) out[id] = m;
  }
  return out;
}

/** song id → its markers in time order ([] = it has none). An id not learned yet is absent. */
export function useSongMarkers(ids: readonly (string | null | undefined)[]): Record<string, LiveMarker[]> {
  const key = useMemo(
    () => Array.from(new Set(ids.filter((x): x is string => !!x))).sort().join(","),
    [ids]
  );
  const [markers, setMarkers] = useState<Record<string, LiveMarker[]>>(() => {
    loadStore();
    return snapshot(key ? key.split(",") : []);
  });
  useEffect(() => {
    loadStore();
    const wanted = key ? key.split(",") : [];
    const update = () => setMarkers(snapshot(wanted));
    update();
    listeners.add(update);
    const stop = () => {
      listeners.delete(update);
    };
    // Ask about every song once per visit (a marker set in the practice room since the last
    // visit should show), but never twice at once.
    const missing = wanted.filter((id) => !asking.has(id));
    if (missing.length === 0) return stop;
    missing.forEach((id) => asking.add(id));
    try {
      createClient()
        .from("song_markers")
        .select("song_id, label, position_seconds, sort_order")
        .in("song_id", missing)
        .order("position_seconds")
        .then(
          ({ data, error }) => {
            if (error || !data) {
              missing.forEach((id) => asking.delete(id));
              return; // offline / not visible: keep what the device remembers
            }
            const fresh = new Map<string, LiveMarker[]>(missing.map((id) => [id, []]));
            for (const r of data as { song_id: string; label: string; position_seconds: number }[]) {
              if (r.label?.trim() && Number.isFinite(r.position_seconds)) {
                fresh.get(r.song_id)?.push({ label: r.label.trim(), at: r.position_seconds });
              }
            }
            for (const [id, list] of fresh) known.set(id, list);
            saveStore();
            listeners.forEach((l) => l());
          },
          () => missing.forEach((id) => asking.delete(id))
        );
    } catch {
      missing.forEach((id) => asking.delete(id));
    }
    return stop;
  }, [key]);
  return markers;
}
