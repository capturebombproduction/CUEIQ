// Shared "save this DOM node as a clean JPG" helper, used by the event run-sheet
// (event-summary) and the label-staff schedule export (overview). It forces a
// light palette on the captured node so dark-mode white text isn't lost on the
// white export background, renders at a fixed width so text doesn't wrap at phone
// width, then shares via the Web Share API (saves straight to the gallery on
// iOS/Android) or falls back to a download on desktop.

// Light-theme variable overrides forced on the captured element during export.
const EXPORT_LIGHT_VARS: Record<string, string> = {
  "--background": "0 0% 100%",
  "--foreground": "222 47% 11%",
  "--card": "0 0% 100%",
  "--card-foreground": "222 47% 11%",
  "--popover": "0 0% 100%",
  "--popover-foreground": "222 47% 11%",
  "--primary": "243 75% 59%",
  "--primary-foreground": "0 0% 100%",
  "--secondary": "220 14% 96%",
  "--secondary-foreground": "222 47% 11%",
  "--muted": "220 14% 96%",
  "--muted-foreground": "220 9% 46%",
  "--accent": "243 75% 96%",
  "--accent-foreground": "243 75% 30%",
  "--border": "220 13% 91%",
  "--destructive": "0 72% 51%",
  "--destructive-foreground": "0 0% 100%",
  "--success": "142 71% 45%",
  "--success-foreground": "0 0% 100%",
};

/**
 * Capture `el` as a JPG and either share it (mobile) or download it (desktop).
 * Returns how it was delivered so the caller can tailor its toast. The caller
 * owns any pre-capture setup (e.g. swapping live iframes for static content) and
 * the busy/disabled state; this only touches `el`'s inline width + palette vars
 * and always restores them, even if capture throws.
 */
export async function captureElementToImage(
  el: HTMLElement,
  {
    filename,
    shareTitle,
    width = 600,
  }: { filename: string; shareTitle?: string; width?: number }
): Promise<"shared" | "downloaded"> {
  const prevWidth = el.style.width;
  try {
    const { toJpeg } = await import("html-to-image");
    // Force a fixed reflow width so text doesn't wrap at mobile width.
    el.style.width = `${width}px`;
    for (const [k, v] of Object.entries(EXPORT_LIGHT_VARS)) {
      el.style.setProperty(k, v);
    }
    await new Promise((r) => setTimeout(r, 80)); // wait for browser reflow
    const dataUrl = await toJpeg(el, {
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
      quality: 0.92,
    });

    // Web Share API — saves directly to gallery on iOS/Android.
    if (navigator.share && navigator.canShare) {
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const file = new File([blob], filename, { type: "image/jpeg" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: shareTitle ?? filename });
          return "shared";
        }
      } catch {
        // share cancelled or unsupported — fall through to download
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
    for (const k of Object.keys(EXPORT_LIGHT_VARS)) el.style.removeProperty(k);
  }
}
