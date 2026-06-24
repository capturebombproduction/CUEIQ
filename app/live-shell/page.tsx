import { LiveShellClient } from "@/components/event/live-shell-client";

// Static, data-free shell so it can be precached by the service worker and served
// for an OFFLINE cold-boot of Live Mode (see public/sw.js + live-shell-client.tsx).
// It lives OUTSIDE the (app) group on purpose: the (app) layout fetches the
// workspace server-side and would fail with no network — this route renders from
// the root layout only and reads everything it needs from IndexedDB on the client.
export const dynamic = "force-static";

export const metadata = {
  title: "Live (ออฟไลน์)",
};

export default function LiveShellPage() {
  return <LiveShellClient />;
}
