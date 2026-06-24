// CueIQ service worker — offline support for live shows (venue Wi-Fi drops mid-set).
// Hand-written, dependency-free. Strategies:
//   • /_next/static/* + icons/fonts → cache-first (content-hashed, immutable)
//   • page navigations (HTML)       → network-first, fall back to the last cached
//                                     render of that page, then a generic notice
//   • everything else               → straight to network (no caching)
// NEVER intercepts Supabase (auth / realtime / storage) or any cross-origin request,
// so audio downloads, realtime sync and login always hit the real network.
//
// Bump VERSION to roll the cache. A new worker does NOT skipWaiting on its own — it
// would otherwise wait until every tab is closed before activating, which an
// installed kiosk PWA rarely does (so it stays stuck on a stale build). Instead the
// app (sw-register.tsx) posts {type:"SKIP_WAITING"} to take the update over at once,
// but only OFF the live/practice pages — so an update can't reload a running show.

const VERSION = "v7";
// STABLE cache names (NOT version-scoped) — this is critical for offline reliability.
// Static assets are content-hashed + immutable, so a new build just adds new keys; a
// SW version bump must NOT wipe them, or every update would drop the JS chunks the app
// already cached online and leave the device unable to boot offline until it re-browses
// online (exactly the bug พี่ hit: update → cache wiped → offline shell had no chunks →
// error loop). Pages stay fresh via network-first while online. Old versioned caches
// from before this scheme are cleaned up once on activate.
const STATIC_CACHE = "cueiq-static";
const PAGE_CACHE = "cueiq-pages";
const KEEP_CACHES = [STATIC_CACHE, PAGE_CACHE];
const PRECACHE = [
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  // practice metronome spoken-count samples — precached so the count is on-device
  // and instant, even offline (see public/sounds/count/).
  "/sounds/count/1.mp3",
  "/sounds/count/2.mp3",
  "/sounds/count/3.mp3",
  "/sounds/count/4.mp3",
  "/sounds/count/5.mp3",
  "/sounds/count/6.mp3",
  "/sounds/count/7.mp3",
  "/sounds/count/8.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(async (c) => {
        // Core assets precached atomically.
        await c.addAll(PRECACHE).catch(() => {});
        // The Live Mode offline cold-boot shell — best-effort and SEPARATE so a
        // hiccup fetching it can't void the whole precache above (addAll is atomic).
        await c.add("/live-shell").catch(() => {});
      })
      .catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Drop only the OLD version-scoped caches (cueiq-*-vN) from before the stable
      // scheme; keep the stable static/page caches so chunks survive SW updates.
      await Promise.all(
        keys
          .filter((k) => k.startsWith("cueiq-") && !KEEP_CACHES.includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// The app asks us to activate immediately (it only does so off the live/practice
// pages — see sw-register.tsx) so a fresh deploy applies without waiting for every
// tab to close. On skipWaiting we activate → claim → drop old caches (see above).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(png|jpg|jpeg|svg|webp|ico|woff2?|mp3|wav|ogg|m4a|aac)$/.test(url.pathname)
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
          if (cached) return cached;
          // Offline + uncached → the UNIVERSAL offline shell so the app always boots
          // with no network instead of dead-ending here. The browser URL is kept, so
          // the shell routes itself: /events/<id>/live boots that show from IndexedDB,
          // anything else (cold start at /dashboard, etc.) shows the offline home that
          // lists the shows prepared on this device. (live-shell-client.tsx)
          const shell = await caches.match("/live-shell");
          if (shell) return shell;
          return new Response(OFFLINE_HTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        })
    );
    return;
  }

  // Everything else (RSC payloads, _next/image, API) → network, no caching.
});

// ---------------------------------------------------------------------------
// Web Push — show a notification on push; focus/open the linked page on click.
// ---------------------------------------------------------------------------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "CueIQ";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { link: data.link || "/dashboard" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/dashboard";
  const url = new URL(link, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          if ("navigate" in c && c.url !== url) {
            try {
              await c.navigate(url);
            } catch (e) {
              /* cross-doc navigate can fail — ignore */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
