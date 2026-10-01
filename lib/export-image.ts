// Shared "save this DOM node as a clean JPG" helper, used by the event run-sheet
// (event-summary) and the label-staff schedule export (overview). It forces a
// light palette on the captured node so dark-mode white text isn't lost on the
// white export background, renders at a fixed width so text doesn't wrap at phone
// width, then shares via the Web Share API (saves straight to the gallery on
// iOS/Android) or falls back to a download on desktop.

/** The light, flat palette for a capture lives in app/theme.css as `.export-light`
 *  (every token, knobs zeroed — the print sheet shares the declarations). It used to
 *  be a hand-kept map of 19 tokens set inline here, and every token added since
 *  (warning, info, the inks …) would have painted its DARK value into the JPG. Tokens
 *  declared on the node itself beat the ones it would inherit from html.dark or a band
 *  skin (both on <html>), and every colour resolves at its use site — so the class is
 *  all it takes, and html-to-image reads those computed colours off the live node. */
export const EXPORT_LIGHT_CLASS = "export-light";

/**
 * Capture `el` as a JPG and either share it (mobile) or download it (desktop).
 * Returns how it was delivered so the caller can tailor its toast. The caller
 * owns any pre-capture setup (e.g. swapping live iframes for static content) and
 * the busy/disabled state; this only touches `el`'s inline width + the export
 * class and always restores them, even if capture throws.
 */
export async function captureElementToImage(
  el: HTMLElement,
  {
    filename,
    shareTitle,
    width = 600,
  }: { filename: string; shareTitle?: string; width?: number }
): Promise<"shared" | "downloaded" | "cancelled"> {
  const prevWidth = el.style.width;
  // A caller that already wears the class (none today) keeps it after the capture.
  const hadClass = el.classList.contains(EXPORT_LIGHT_CLASS);
  try {
    const { toJpeg } = await import("html-to-image");
    // Force a fixed reflow width so text doesn't wrap at mobile width.
    el.style.width = `${width}px`;
    el.classList.add(EXPORT_LIGHT_CLASS);
    await new Promise((r) => setTimeout(r, 80)); // wait for browser reflow
    const dataUrl = await toJpeg(el, {
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
      quality: 0.92,
    });
    // A node that isn't laid out (0×0 — e.g. captured while its container is
    // hidden) makes an empty canvas, and toDataURL() hands back "data:," without
    // throwing. Saving that would give the crew a 0-byte .jpg under a success
    // toast, so surface it as a failure the caller already reports.
    if (!dataUrl.startsWith("data:image/")) {
      throw new Error("รูปที่ได้ว่างเปล่า ลองใหม่อีกครั้ง");
    }

    // Web Share API — saves directly to gallery on iOS/Android.
    // NOT under Electron: Chromium exposes navigator.share and canShare({files})
    // returns true there, but the desktop app's browser process implements no share
    // service, so the call rejects with a synthetic AbortError that is
    // indistinguishable from a user dismissal. Taking the download path it always
    // took is both correct and what a desktop user wants anyway.
    const isNative =
      typeof window !== "undefined" &&
      !!(window as Window & { cueiqNative?: unknown }).cueiqNative;
    if (!isNative && navigator.share && navigator.canShare) {
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const file = new File([blob], filename, { type: "image/jpeg" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: shareTitle ?? filename });
          return "shared";
        }
      } catch (err) {
        // Dismissing the share sheet REJECTS the promise — and a bare catch treated
        // that exactly like "this browser can't share", fell through to the
        // <a download> path (which iOS ignores) and told the user "บันทึกรูปแล้ว".
        // So the one action a person takes to say "no, not that" was reported back
        // as done, with nothing saved anywhere.
        //
        // ONLY AbortError. NotAllowedError means the share sheet never opened at
        // all — usually because the tap's activation window expired while a big
        // board rendered — and the user cannot have cancelled something they were
        // never shown. That one must keep falling through to the download, which is
        // exactly what used to save the file for them on Chromium.
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError") return "cancelled";
        // genuinely unsupported / never presented → the download fallback below
      }
    }

    // Desktop fallback
    const a = document.createElement("a");
    a.download = filename;
    a.href = dataUrl;
    a.click();
    return "downloaded";
  } finally {
    el.style.width = prevWidth; // always restore — even if capture threw
    if (!hadClass) el.classList.remove(EXPORT_LIGHT_CLASS);
  }
}
