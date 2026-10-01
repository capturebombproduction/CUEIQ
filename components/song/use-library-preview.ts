"use client";

// Library preview — ONE <audio> element, one song at a time, scoped to the page.
//
// No new audio pipeline: the source chain is the practice player's (selectSong in
// components/practice/practice-player.tsx), call for call. A per-device local
// override wins (lib/local-source — the desktop's "ใช้ไฟล์ในเครื่องนี้", and an
// offline upload still waiting in the queue); otherwise the shared path-keyed cache
// (lib/song-cache), which downloads once through the same presigned R2 GET as
// everything else (lib/audio-remote — on the desktop that GET goes through the
// main process, see configureAudioTransport in desktop/src/main.tsx). A side effect
// worth having: a song previewed here opens instantly in a practice room later.
//
// Two rules this file exists to keep:
//  • The tap's gesture must reach play(). WebKit grants playback per ELEMENT and
//    only inside a user gesture, and the bytes arrive after awaits (IndexedDB, maybe
//    a download) — so the element plays a moment of silence synchronously in the
//    tap, the same priming live-mode.tsx's primeElement does, and the real play()
//    later is already allowed.
//  • It is a PREVIEW. It stops (pause + src removed, download cancelled) when the
//    page unmounts, when the route changes, and on pagehide. A preview still
//    sounding when someone opens Live Mode or a practice room is a second,
//    uncontrolled source of sound on the very device that is meant to have exactly
//    one.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { getLocalSource } from "@/lib/local-source";
import { getSongBlob } from "@/lib/song-cache";
import type { Song } from "@/lib/types";

export type PreviewSong = Pick<Song, "id" | "title" | "audio_path" | "duration_seconds">;

export interface LibraryPreview {
  /** The song in the mini-player — loading, playing or paused — or null. */
  current: { id: string; title: string } | null;
  playing: boolean;
  /** Its bytes are still on their way (IndexedDB read, maybe a download). */
  loading: boolean;
  position: number;
  duration: number;
  /** Start `song`; on the song already in the player, play/pause it instead. */
  play: (song: PreviewSong) => void;
  toggle: () => void;
  stop: () => void;
}

// The same 44-byte silent WAV live-mode.tsx primes its elements with.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

// play()'s rejection and the element's own `error` event usually report the SAME
// failure; one toast id makes the second replace the first instead of stacking.
const ERROR_TOAST_ID = "library-preview-error";

function errorName(err: unknown): string | undefined {
  return err && typeof err === "object" && "name" in err
    ? String((err as { name: unknown }).name)
    : undefined;
}

export function useLibraryPreview(): LibraryPreview {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // The blob: URL of the song loaded now. Every element listener checks the
  // element's src against it, so the priming silence (and a src being torn down)
  // never flips the UI to "playing" or moves the clock.
  const urlRef = useRef<string | null>(null);
  // Newest tap wins, as in the practice player: every await re-checks this, and
  // stop() bumps it too, so a slow download can never start sounding after the
  // user picked something else, closed the player, or left the page.
  const tokenRef = useRef(0);
  // The token only keeps a superseded download from SOUNDING; this keeps it from
  // DOWNLOADING. Without it, a member who taps ▶ on a few songs and then opens Live
  // Mode leaves those masters (27–88 MB each, with retries) still pulling on the
  // venue link Live Mode needs. Aborted wherever the token is bumped to supersede.
  const abortRef = useRef<AbortController | null>(null);
  // Refs for what the tap handlers branch on — two taps inside one render must
  // not both read the stale state of the render before.
  const currentRef = useRef<{ id: string; title: string } | null>(null);
  const loadingRef = useRef(false);

  const [current, setCurrent] = useState<{ id: string; title: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  const setLoadingBoth = (v: boolean) => {
    loadingRef.current = v;
    setLoading(v);
  };

  // Stable (refs + setters only), because the teardown effect below depends on it.
  const stop = useCallback(() => {
    tokenRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
      } catch {
        /* nothing here may throw out of a teardown */
      }
      if (a.hasAttribute("src")) {
        a.removeAttribute("src");
        // Without load() the element can keep the old resource; with it, it is
        // empty — nothing left that a stray play() could resume.
        try {
          a.load();
        } catch {
          /* ignore */
        }
      }
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    currentRef.current = null;
    loadingRef.current = false;
    setCurrent(null);
    setLoading(false);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }, []);

  function fail(err: unknown) {
    const name = errorName(err);
    toast.error("เล่นตัวอย่างไม่สำเร็จ", {
      id: ERROR_TOAST_ID,
      description:
        name === "NotSupportedError" || name === "MediaError"
          ? "เครื่องนี้เปิดไฟล์นี้ไม่ได้ — ฟอร์แมตอาจไม่รองรับ"
          : err instanceof Error && err.message
            ? err.message
            : "ลองใหม่อีกครั้ง",
    });
    stop();
  }

  // The browser refused play() — on a phone that means the gesture did not reach
  // it after all. Keep the song loaded and paused: ▶ in the mini-player is a fresh
  // tap that plays synchronously, so it always works.
  function refused() {
    setLoadingBoth(false);
    setPlaying(false);
    toast.info("แตะ ▶ อีกครั้งเพื่อเล่น", { id: ERROR_TOAST_ID });
  }

  function ensureAudio(): HTMLAudioElement {
    if (audioRef.current) return audioRef.current;
    const a = new Audio();
    a.preload = "auto";
    const ours = () => !!urlRef.current && a.getAttribute("src") === urlRef.current;
    a.addEventListener("play", () => {
      if (ours()) setPlaying(true);
    });
    a.addEventListener("pause", () => {
      if (ours()) setPlaying(false);
    });
    a.addEventListener("ended", () => {
      if (ours()) setPlaying(false);
    });
    a.addEventListener("timeupdate", () => {
      if (ours()) setPosition(a.currentTime);
    });
    const onDuration = () => {
      if (ours() && isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
    };
    a.addEventListener("loadedmetadata", onDuration);
    a.addEventListener("durationchange", onDuration);
    a.addEventListener("error", () => {
      if (ours()) fail({ name: "MediaError" });
    });
    audioRef.current = a;
    return a;
  }

  /** Must run synchronously inside the tap — see the header. */
  function prime(a: HTMLAudioElement) {
    try {
      a.src = SILENT_WAV;
      const p = a.play();
      const done = () => {
        // A real song may have taken the element over meanwhile; leave that alone.
        if (a.getAttribute("src") === SILENT_WAV) {
          a.pause();
          a.removeAttribute("src");
        }
      };
      // Setting the real src rejects this promise (AbortError) — that is fine.
      void p?.then(done, done);
    } catch {
      /* best-effort: desktop Chromium does not need it at all */
    }
  }

  async function load(
    song: PreviewSong,
    a: HTMLAudioElement,
    token: number,
    signal: AbortSignal
  ) {
    try {
      const local = await getLocalSource(song.id);
      if (token !== tokenRef.current) return;
      // No master and no local bytes: the queue flushed (override cleared, file
      // now online) but this page's song list predates it — the practice player
      // says the same thing in the same spot.
      if (!local && !song.audio_path) {
        toast.info("ไฟล์เพิ่งอัปขึ้นคลังแล้ว", {
          description: "รีเฟรชหน้านี้อีกครั้งเพื่อฟังจากคลัง",
        });
        stop();
        return;
      }
      const blob = local?.blob ?? (await getSongBlob(song.audio_path!, { signal }));
      if (token !== tokenRef.current) return;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      a.src = url;
      await a.play();
      if (token !== tokenRef.current) return;
      setLoadingBoth(false);
    } catch (err) {
      // Superseded (a newer tap, close, or leaving the page) — that path already
      // owns the UI. Our own abort of the download lands here too, so it is silent.
      if (token !== tokenRef.current) return;
      const name = errorName(err);
      // An AbortError means two things here. From the element's own play() — the
      // src is set, so urlRef is — it was only interrupted: leave it loaded and
      // paused so ▶ still works, instead of a spinner that never ends. Before that
      // it can only be the TRANSFER giving up (audio-remote aborts a stalled
      // presign or byte stream with a bare abort()), and that is a failure: left
      // open with no URL, ▶ would do nothing and nothing would say why.
      if (name === "AbortError" && urlRef.current) setLoadingBoth(false);
      else if (name === "AbortError") fail(new Error("เน็ตช้าหรือหลุด — ลองใหม่อีกครั้ง"));
      else if (name === "NotAllowedError") refused();
      else fail(err);
    }
  }

  function toggle() {
    const a = audioRef.current;
    if (!a || !currentRef.current) return;
    // While the bytes are still on their way, a second tap means "never mind".
    if (loadingRef.current) {
      stop();
      return;
    }
    if (!urlRef.current) return;
    if (a.paused) {
      // Synchronous, inside the tap: this is the call the gesture must reach.
      a.play().catch((err: unknown) => {
        if (errorName(err) === "AbortError") return;
        if (errorName(err) === "NotAllowedError") refused();
        else fail(err);
      });
    } else {
      a.pause();
    }
  }

  function play(song: PreviewSong) {
    if (currentRef.current?.id === song.id) {
      toggle();
      return;
    }
    const a = ensureAudio();
    // The song being replaced goes quiet NOW, not when the next one's bytes land.
    try {
      a.pause();
    } catch {
      /* ignore */
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    prime(a);
    const token = ++tokenRef.current;
    // ...and its download stops too, not just its sound.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const next = { id: song.id, title: song.title };
    currentRef.current = next;
    setCurrent(next);
    setLoadingBoth(true);
    setPlaying(false);
    setPosition(0);
    // The library's own length until the file reports its real one.
    setDuration(song.duration_seconds > 0 ? song.duration_seconds : 0);
    void load(song, a, token, ac.signal);
  }

  // Leaving the page — unmount, a route change, or the tab going away — always
  // stops. The cleanup runs on unmount AND whenever the pathname changes, so even
  // a layout that kept this page mounted across a navigation could not carry a
  // preview into Live Mode or a practice room.
  const pathname = usePathname();
  useEffect(() => {
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [pathname, stop]);

  return { current, playing, loading, position, duration, play, toggle, stop };
}
