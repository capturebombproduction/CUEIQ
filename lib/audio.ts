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
      reject(new Error("เปิดไฟล์เสียงไม่สำเร็จ — ฟอร์แมตอาจไม่รองรับ"));
    };

    audio.src = url;
  });
}
