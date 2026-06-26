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
import { Shell } from "~/components/shell";
import { WorkspaceProvider } from "~/data/workspace-context";

type AuthState = { loading: boolean; session: Session | null };

/** Watches the Supabase auth session (same backend as the web app) and gates routes. */
function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ loading: true, session: null });
  useEffect(() => {
    const supabase = createClient();
    supabase.auth
      .getSession()
      .then(({ data }) => setState({ loading: false, session: data.session }))
      .catch(() => setState({ loading: false, session: null }));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setState({ loading: false, session });
    });
    return () => sub.subscription.unsubscribe();
  }, []);
  return state;
}

function Protected({ session, children }: { session: Session | null; children: React.ReactNode }) {
  const loc = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function App() {
  const { loading, session } = useAuth();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 text-muted-foreground">
        กำลังโหลด…
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />

      {/* Authenticated app — workspace loaded once, shared with the shell + pages. */}
      <Route
        element={
          <Protected session={session}>
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
