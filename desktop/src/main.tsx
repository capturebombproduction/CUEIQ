import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { StageLight } from "@/components/stage-light";
import { createClient } from "@/lib/supabase/client";
import { configureAudioTransport } from "@/lib/audio-remote";
import {
  registerMgmtQueueSink,
  registerPendingAudioDropper,
  registerPendingAudioReader,
} from "@/lib/mgmt-write";
import {
  dropPendingAudioUploadOp,
  enqueueMgmtOp,
  pendingAudioSongIds,
} from "~/data/mgmt-outbox";
import { App } from "~/App";
import "./index.css";

// Offline MANAGEMENT writes (⭐#1 step 2): point EventForm's write seam at the
// desktop outbox, so a create/edit that fails on a dead network is queued +
// synced on reconnect instead of lost. The web never registers a sink → inert there.
registerMgmtQueueSink(enqueueMgmtOp);
// ⭐#1 step 6: and let the shared Library ask which songs still have audio waiting
// to be pushed, so it can badge them "รออัปโหลด" instead of looking empty-handed.
registerPendingAudioReader(pendingAudioSongIds);
// …and to cancel one that a later real upload has made obsolete.
registerPendingAudioDropper(dropPendingAudioUploadOp);

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

// A file dropped outside a designated target must NOT navigate the window to that
// file (Chromium's default — it would unload the running SPA). preventDefault only,
// no stopPropagation: in-app drag targets (row reorder in Quick Show / setlist /
// schedule) keep their own handlers and still work.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

/**
 * Last-resort fallback: without a boundary, ANY render throw unmounts the whole tree
 * and leaves a white window — mid-show, with nothing to click and no console in the
 * packaged app. Kept deliberately dumb (plain markup, no app components: whatever
 * threw may well live in them) and always offering both escapes: reload, or the
 * fully-local Quick Show runner. Navigating a crashed tree can't work from here, so
 * Quick Show sets the hash and reloads into it.
 */
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      // data-cueiq-screen — see the note on App.tsx's BootScreen.
      // The Black Stage in plain markup (the sign-in screen's wrapper, a slab, the
      // Button primitive's own classes written out): this screen is built out of
      // elements and classes only, so whatever threw cannot be in it. StageLight is a
      // bare <div> — and the only light in the document, the crashed tree is gone.
      <div
        data-cueiq-screen="app-error"
        className="relative isolate grid min-h-screen place-items-center bg-background p-4"
      >
        <StageLight />
        <div className="slab w-full max-w-md space-y-4 rounded-[3px] p-6 text-center">
          <h1 className="text-xl font-bold text-destructive">แอปทำงานผิดพลาด</h1>
          <p className="text-sm text-muted-foreground">
            กด “โหลดใหม่” เพื่อเริ่มหน้าจอใหม่ ถ้ายังไม่หาย เปิด Quick Show
            เพื่อคุมโชว์ต่อจากไฟล์ในเครื่องนี้ (ไม่ต้องใช้เน็ต)
          </p>
          <pre className="max-h-40 overflow-auto rounded-[2px] bg-muted p-3 text-left text-xs text-muted-foreground [scrollbar-color:hsl(var(--muted-foreground)/.45)_transparent] [scrollbar-width:thin]">
            {String(error.message || error)}
          </pre>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[3px] bg-primary px-4 text-[15px] font-semibold text-primary-foreground transition-colors hover:bg-primary/[.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              โหลดใหม่
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.hash = "#/my-show";
                window.location.reload();
              }}
              className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[3px] bg-transparent px-4 text-[15px] font-semibold shadow-[inset_0_0_0_1.5px_hsl(var(--input))] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Quick Show
            </button>
          </div>
        </div>
      </div>
    );
  }
}

// HashRouter: works under file:// (Electron) and in the browser dev server alike.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <HashRouter>
        <App />
        <Toaster richColors position="top-center" />
      </HashRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);
