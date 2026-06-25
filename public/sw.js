// CueIQ service worker — Web Push ONLY.
//
// The offline-run path moved to the dedicated CueIQ Desktop app (Electron, boots
// from disk). The web app is now ONLINE management + on-demand playback, so this
// worker no longer caches anything or intercepts fetches — every request goes
// straight to the network. Its sole job is to receive Web Push notifications and
// open the linked page on click.
//
// IMPORTANT (no residue): a device that ran an older build still has the old
// offline caches (cueiq-static / cueiq-pages / cueiq-*-vN) and a fetch-intercepting
// worker. On install we skipWaiting to replace that worker at once, and on activate
// we DELETE every cueiq-* cache so nothing stale is left on the device. With no
// fetch handler the browser stops routing traffic through us entirely.
//
// Bump VERSION to force existing installs to pick up this worker.
const VERSION = "v8-push-only";

self.addEventListener("install", () => {
  // Take over from the old offline worker immediately (don't wait for tabs to close).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Wipe ALL caches this app ever created — the old offline shell, static and
      // page caches included. Leaves the device clean (no residue).
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("cueiq-")).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
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
