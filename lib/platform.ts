// Small platform probes, shared so the answers can't drift between the three
// places that ask them. All of them touch `window`/`navigator`, so call them from
// an effect — never during render, since both consumers are server-rendered and a
// render-time read would either crash on the server or mismatch on hydration.

/** Running as an installed app (home-screen / PWA window) rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: fullscreen)").matches === true ||
    // Apple's own non-standard flag — the only signal an iOS home-screen app gives.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS or iPadOS, whatever browser is wrapped around it — every engine on the
 * platform is WebKit, so the limitations are the same in Safari and in Chrome-iOS.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
