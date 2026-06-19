// CueIQ service worker — offline support for live shows (venue Wi-Fi drops mid-set).
// Hand-written, dependency-free. Strategies:
//   • /_next/static/* + icons/fonts → cache-first (content-hashed, immutable)
//   • page navigations (HTML)       → network-first, fall back to the last cached
//                                     render of that page, then a generic notice
//   • everything else               → straight to network (no caching)
// NEVER intercepts Supabase (auth / realtime / storage) or any cross-origin request,
// so audio downloads, realtime sync and login always hit the real network.
//
// Bump VERSION to roll the cache. A new worker does NOT skipWaiting — it waits until
// every tab is closed before activating, so an update can't disrupt a running show.

const VERSION = "v1";
const STATIC_CACHE = `cueiq-static-${VERSION}`;
const PAGE_CACHE = `cueiq-pages-${VERSION}`;
const PRECACHE = [
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("cueiq-") && !k.endsWith(VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(png|jpg|jpeg|svg|webp|ico|woff2?)$/.test(url.pathname)
  );
}

const OFFLINE_HTML =
  "<!doctype html><meta charset=utf-8>" +
  "<meta name=viewport content='width=device-width,initial-scale=1'>" +
  "<title>ออฟไลน์ — CueIQ</title>" +
  "<body style='font-family:Kanit,sans-serif;background:#0b0b0f;color:#eee;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:1rem'>" +
  "<div><h1 style='margin:.2em 0'>📴 ออฟไลน์</h1>" +
  "<p style='opacity:.8;line-height:1.6'>ยังไม่มีการเชื่อมต่อ และยังไม่เคยเปิดหน้านี้ไว้ในเครื่อง<br>" +
  "ลองเปิดหน้าที่เคยโหลดแล้ว หรือเชื่อมต่ออินเทอร์เน็ตอีกครั้ง</p></div></body>";

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only same-origin. Supabase / Google Maps / any other origin → real network.
  if (url.origin !== self.location.origin) return;

  // Immutable static assets: cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Page navigations: network-first so you always get fresh data online; offline,
  // fall back to the last good render of this page (it carries the data that was
  // loaded when last online — the running show then survives on cached audio +
  // the localStorage crash snapshot).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGE_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached =
            (await caches.match(req)) ||
            (await caches.match(req, { ignoreSearch: true }));
          return (
            cached ||
            new Response(OFFLINE_HTML, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            })
          );
        })
    );
    return;
  }

  // Everything else (RSC payloads, _next/image, API) → network, no caching.
});
