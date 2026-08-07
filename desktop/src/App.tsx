import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import { Play } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { RefreshButton } from "@/components/refresh-button";
import { Login } from "~/pages/Login";
import { Dashboard } from "~/pages/dashboard";
import { EventPage } from "~/pages/event";
import { NewEventPage } from "~/pages/event-new";
import { EditEventPage } from "~/pages/event-edit";
import { RunOrderPage } from "~/pages/run-order";
import { RunOrderLivePage } from "~/pages/run-order-live";
import { LivePage } from "~/pages/live";
import { Library } from "~/pages/library";
import { Artists } from "~/pages/artists";
import { Overview } from "~/pages/overview";
import { Training } from "~/pages/training";
import { PracticeRoom } from "~/pages/practice";
import { Crew } from "~/pages/crew";
import { Admin } from "~/pages/admin";
import { MyShow } from "~/pages/my-show";
import { Shell } from "~/components/shell";
import { WorkspaceProvider } from "~/data/workspace-context";
import { clearCache } from "~/data/cache";
import { clearMgmtOutbox } from "~/data/mgmt-outbox";
import { getStoredSessionUser } from "~/data/stored-session";

type AuthState = {
  loading: boolean;
  session: Session | null;
  /** Offline show pass: getSession() came back null (expired token + no network
   * to refresh) but a persisted session still exists — the user never signed
   * out. Lets the app boot into cached data + cached audio instead of bouncing
   * to /login at a no-internet venue; upgraded to a real session automatically
   * when the network returns (TOKEN_REFRESHED). See ~/data/stored-session. */
  offlineAuthed: boolean;
};

/** How long boot may wait for the session before falling through to the offline
 *  path. A venue network that is JOINED but black-holed (navigator.onLine true,
 *  TCP connects, nothing ever answers) leaves the token-refresh POST hanging with
 *  no timeout of its own — unbounded, that pins the app on the boot screen with no
 *  routes mounted, not even Quick Show. */
const BOOT_SESSION_TIMEOUT_MS = 5000;

/** Watches the Supabase auth session (same backend as the web app) and gates routes. */
function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
    offlineAuthed: false,
  });
  useEffect(() => {
    const supabase = createClient();
    let resolved = false;
    const next = (session: Session | null) => {
      resolved = true;
      setState({
        loading: false,
        session,
        offlineAuthed: !session && getStoredSessionUser() != null,
      });
    };
    supabase.auth
      .getSession()
      .then(({ data }) => next(data.session))
      .catch(() => next(null));
    // Dead-network boot guard: if getSession() never settles, take the SAME path an
    // expired-but-unrefreshable session already takes — offline identity when one is
    // stored, otherwise the login screen. It grants nothing extra (RLS + the stored
    // session are still the only keys); it only stops the wait. A late getSession() /
    // onAuthStateChange result still calls next() and upgrades the state afterwards.
    const bootTimer = window.setTimeout(() => {
      if (!resolved) next(null);
    }, BOOT_SESSION_TIMEOUT_MS);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      // Shared band device: wipe the offline management cache the moment a user
      // signs out, so the NEXT account on this machine can never boot offline
      // into the previous user's cached workspace/events (different per-band perms).
      // (A real sign-out also removes the persisted session, so the offline pass
      // closes with it — SIGNED_OUT is never emitted for mere network failures.)
      // The mgmt outbox goes too: queued writes must never flush as the next
      // account (the "ค้างซิงค์" chip makes pending work visible before sign-out).
      if (event === "SIGNED_OUT") {
        clearCache();
        clearMgmtOutbox().catch(() => {});
      }
      next(session);
    });
    return () => {
      window.clearTimeout(bootTimer);
      sub.subscription.unsubscribe();
    };
  }, []);
  return state;
}

function Protected({ authed, children }: { authed: boolean; children: React.ReactNode }) {
  const loc = useLocation();
  if (!authed) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

/** Boot screen while the session resolves. It ALWAYS offers a way out: even with the
 *  timeout above, a venue network can make this stretch, and the operator must still
 *  be able to retry or reach Quick Show — the runner that needs neither. */
function BootScreen() {
  return (
    // data-cueiq-screen: the packaged app's self-test has to tell six screens apart
    // from the main process, and four of them are a centered card with a Thai
    // "กำลังโหลด…" in it. Matching display text would pin CI to copy AND push Thai
    // through a workflow file; this is one stable token per screen. See
    // desktop/electron/main.cjs's smoke block and desktop/scripts/run-smoke.mjs.
    <div
      data-cueiq-screen="boot"
      className="grid min-h-screen place-items-center bg-muted/30 p-4"
    >
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-primary">CueIQ</h1>
          <p className="mt-1 text-sm text-muted-foreground">กำลังโหลด…</p>
        </div>
        <div className="flex justify-center">
          <RefreshButton label="ลองใหม่" />
        </div>
        {/* Same Quick Show entry as the login screen (see ~/pages/Login). */}
        <Link
          to="/my-show"
          className="group flex items-center gap-3 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3 shadow-sm transition-colors hover:border-primary/70 hover:bg-primary/10"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors group-hover:bg-primary/25">
            <Play className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-primary">Quick Show</span>
            <span className="block text-xs text-muted-foreground">
              โหมดโชว์เดี่ยว — เปิดเพลง+จับเวลาจากเครื่องนี้ ไม่ต้องเข้าสู่ระบบ
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}

export function App() {
  const { loading, session, offlineAuthed } = useAuth();
  const authed = !!session || offlineAuthed;

  // While loading, the routes stay MOUNTED and only the gated branches show the boot
  // screen (they used to be replaced wholesale by a spinner, which made /my-show
  // unreachable exactly when it is needed most). Quick Show hangs off its own route,
  // so it renders straight away and is never remounted when loading flips.
  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <BootScreen /> : authed ? <Navigate to="/" replace /> : <Login />}
      />
      {/* QUICK SHOW (โหมดโชว์เดี่ยว, formerly "My Show") — deliberately OUTSIDE the
          auth gate: fully local standalone show runner (no login, no cloud), usable
          on a brand-new machine. Grew out of the emergency player; /emergency and
          /quick-show are aliases (route stays /my-show so saved data/links hold). */}
      <Route path="/my-show" element={<MyShow />} />
      <Route path="/quick-show" element={<Navigate to="/my-show" replace />} />
      <Route path="/emergency" element={<Navigate to="/my-show" replace />} />

      {/* Authenticated app — workspace loaded once, shared with the shell + pages. */}
      <Route
        element={
          loading ? (
            <BootScreen />
          ) : (
            <Protected authed={authed}>
              <WorkspaceProvider>
                <Shell />
              </WorkspaceProvider>
            </Protected>
          )
        }
      >
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/events/new" element={<NewEventPage />} />
        <Route path="/events/:id" element={<EventPage />} />
        <Route path="/events/:id/edit" element={<EditEventPage />} />
        <Route path="/events/:id/run-order" element={<RunOrderPage />} />
        <Route path="/events/:id/run-order/live" element={<RunOrderLivePage />} />
        <Route path="/events/:id/live" element={<LivePage />} />
        <Route path="/events/:id/practice" element={<PracticeRoom />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/library" element={<Library />} />
        <Route path="/practice" element={<Training />} />
        <Route path="/groups" element={<Artists />} />
        <Route path="/crew" element={<Crew />} />
        {/* Admin needs server-side secrets (service_role/R2) the renderer can't
            bundle, so it opens the web Admin in the system browser. */}
        <Route path="/admin" element={<Admin />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
