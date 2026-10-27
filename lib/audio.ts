// ---------------------------------------------------------------------------
// Client-side audio duration detection.
//
// We deliberately DO NOT upload or store the audio file. We only read its
// metadata in the browser to detect the duration, then keep the file name +
// duration. This avoids storage cost and copyright issues with hosting audio.
// ---------------------------------------------------------------------------

/**
 * Why the players here cannot open `file`, or null. AIFF: Chromium - the desktop app, Chrome,
 * Edge - has no AIFF demuxer at all (measured in Electron 42.8.1: canPlayType "",
 * DEMUXER_ERROR_COULD_NOT_OPEN, decodeAudioData EncodingError), while Safari plays it. So a
 * master exported from a Mac as AIFF would go into the library, play on the Mac that uploaded
 * it, and be silent on the show laptop. WAV holds the same PCM: converting loses nothing.
 */
export function unplayableAudio(file: { name: string; type?: string }): string | null {
  if (/\.(aiff?|aifc)$/i.test(file.name) || /^audio\/(x-)?aiff?$/i.test(file.type ?? "")) {
    return "แอปเล่นไฟล์ AIFF ไม่ได้ — แปลงเป็น WAV ก่อน (เสียงเท่าเดิม ไม่เสียคุณภาพ)";
  }
  return null;
}

/**
 * What the user reads when a player cannot open a file at all (the media element's `error`).
 * Not the same as a length it could not read: that file still plays, and the length is typed.
 */
export const UNOPENABLE_AUDIO_MESSAGE =
  "เปิดไฟล์เสียงนี้ไม่ได้ — ฟอร์แมตอาจไม่รองรับ แปลงเป็น WAV หรือ MP3 ก่อน";

/** detectAudioDuration's rejection when the file could not be OPENED (vs. a length unread). */
export function isUnopenableAudioError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { cueiqUnopenable?: unknown }).cueiqUnopenable === true;
}

/**
 * UNOPENABLE_AUDIO_MESSAGE when this device's player refuses `file` outright, else null.
 *
 * `accept="audio/*"` lets through what Chromium (the show laptop, Chrome, Edge) has no decoder
 * for - .wma, .amr, an ALAC .m4a from Apple Music - and the library uploaded it as the master:
 * the old take deleted, a green "มีไฟล์" badge, and every device silent on that row at showtime
 * (2026-10-27, hunt 7). AIFF had been refused by name (unplayableAudio); this asks the player.
 *
 * Only a real `error` refuses. No answer within `timeoutMs` (a slow disk, or a test DOM with no
 * media stack) is null: a file we could not judge is not a file we judged bad.
 */
export function audioOpenProblem(file: Blob, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
      resolve(null);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    let done = false;
    const finish = (answer: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    audio.onloadedmetadata = () => finish(null);
    audio.onerror = () => finish(UNOPENABLE_AUDIO_MESSAGE);
    audio.src = url;
  });
}

/**
 * Detect the duration (in whole seconds) of a chosen audio file by loading
 * just its metadata into a throwaway <audio> element. The file never leaves
 * the browser.
 */
export function detectAudioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) {
      reject(new Error("ไฟล์นี้ไม่ใช่ไฟล์เสียง"));
      return;
    }

    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";

    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
    };

    audio.onloadedmetadata = () => {
      const d = audio.duration;
      cleanup();
      if (!isFinite(d) || isNaN(d) || d <= 0) {
        reject(new Error("อ่านความยาวไฟล์ไม่ได้ — ลองกรอกเองได้"));
      } else {
        resolve(Math.round(d));
      }
    };

    audio.onerror = () => {
      cleanup();
      // tagged: the library refuses such a file instead of uploading it (isUnopenableAudioError)
      reject(Object.assign(new Error("เปิดไฟล์เสียงไม่สำเร็จ — ฟอร์แมตอาจไม่รองรับ"), { cueiqUnopenable: true }));
    };

    audio.src = url;
  });
}

/**
 * The text of an error thrown across Electron's IPC (window.cueiqNative.*), without the
 * "Error invoking remote method 'cueiq:…': Error: " Electron puts in front of the main
 * process's own message - the Thai "ไฟล์ใหญ่เกินไป (N MB) …" read as English plumbing
 * followed by Thai (2026-10-27, hunt 7). Any other error's message as it is.
 */
export function nativeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
