import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Login } from "~/pages/Login";
import { Dashboard } from "~/pages/dashboard";
import { EventPage } from "~/pages/event";
import { LivePage } from "~/pages/live";
import { ComingSoon } from "~/pages/coming-soon";
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
        <Route path="/events/:id" element={<EventPage />} />
        <Route path="/events/:id/live" element={<LivePage />} />
        {/* Not-yet-ported nav sections — reachable so the reused nav stays honest. */}
        <Route path="/overview" element={<ComingSoon title="Overview" />} />
        <Route path="/library" element={<ComingSoon title="Library" />} />
        <Route path="/practice" element={<ComingSoon title="Training" />} />
        <Route path="/groups" element={<ComingSoon title="Artists" />} />
        <Route path="/crew" element={<ComingSoon title="Crew" />} />
        <Route path="/admin" element={<ComingSoon title="Admin" />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
