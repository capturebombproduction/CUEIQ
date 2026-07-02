import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { configureAudioTransport } from "@/lib/audio-remote";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { enqueueMgmtOp } from "~/data/mgmt-outbox";
import { App } from "~/App";
import "./index.css";

// Offline MANAGEMENT writes (⭐#1 step 2): point EventForm's write seam at the
// desktop outbox, so a create/edit that fails on a dead network is queued +
// synced on reconnect instead of lost. The web never registers a sink → inert there.
registerMgmtQueueSink(enqueueMgmtOp);

// Reused R2 audio transport (lib/audio-remote) targets a same-origin /api route on
// the web; the desktop SPA has none, so point it at the web origin and authorize
// with the current session's Bearer token (cookies don't travel cross-origin). The
// web route accepts either cookie or Bearer auth. Offline, presign simply fails and
// playback falls back to the IndexedDB cache — exactly the offline-first contract.
const native = typeof window !== "undefined" ? window.cueiqNative : undefined;
configureAudioTransport({
  endpointBase: process.env.CUEIQ_WEB_ORIGIN,
  getAuthHeaders: async (): Promise<Record<string, string>> => {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  // Under Electron, move the R2 bytes through the main process (no browser CORS).
  // In a plain browser (dev preview) these stay undefined → direct browser fetch.
  ...(native
    ? {
        fetchBlob: async (url: string) => new Blob([await native.fetchAudio(url)]),
        putBlob: async (url: string, body: Blob, contentType?: string) =>
          native.putAudio(url, new Uint8Array(await body.arrayBuffer()), contentType),
      }
    : {}),
});

// HashRouter: works under file:// (Electron) and in the browser dev server alike.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
      <Toaster richColors position="top-center" />
    </HashRouter>
  </React.StrictMode>
);
