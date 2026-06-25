import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { configureAudioTransport } from "@/lib/audio-remote";
import { App } from "~/App";
import "./index.css";

// Reused R2 audio transport (lib/audio-remote) targets a same-origin /api route on
// the web; the desktop SPA has none, so point it at the web origin and authorize
// with the current session's Bearer token (cookies don't travel cross-origin). The
// web route accepts either cookie or Bearer auth. Offline, presign simply fails and
// playback falls back to the IndexedDB cache — exactly the offline-first contract.
configureAudioTransport({
  endpointBase: process.env.CUEIQ_WEB_ORIGIN,
  getAuthHeaders: async (): Promise<Record<string, string>> => {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
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
