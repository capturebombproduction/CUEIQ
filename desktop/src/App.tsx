import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
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

/** Watches the Supabase auth session (same backend as the web app) and gates routes. */
function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
    offlineAuthed: false,
  });
  useEffect(() => {
    const supabase = createClient();
    const next = (session: Session | null) =>
      setState({
        loading: false,
        session,
        offlineAuthed: !session && getStoredSessionUser() != null,
      });
    supabase.auth
      .getSession()
      .then(({ data }) => next(data.session))
      .catch(() => next(null));
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
    return () => sub.subscription.unsubscribe();
  }, []);
  return state;
}

function Protected({ authed, children }: { authed: boolean; children: React.ReactNode }) {
  const loc = useLocation();
  if (!authed) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { loading, session, offlineAuthed } = useAuth();
  const authed = !!session || offlineAuthed;

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 text-muted-foreground">
        กำลังโหลด…
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={authed ? <Navigate to="/" replace /> : <Login />} />
      {/* MY SHOW (โหมดโชว์เดี่ยว) — deliberately OUTSIDE the auth gate: fully local
          standalone show runner (no login, no cloud), usable on a brand-new machine.
          Grew out of the emergency player; /emergency stays as a redirect. */}
      <Route path="/my-show" element={<MyShow />} />
      <Route path="/emergency" element={<Navigate to="/my-show" replace />} />

      {/* Authenticated app — workspace loaded once, shared with the shell + pages. */}
      <Route
        element={
          <Protected authed={authed}>
            <WorkspaceProvider>
              <Shell />
            </WorkspaceProvider>
          </Protected>
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
