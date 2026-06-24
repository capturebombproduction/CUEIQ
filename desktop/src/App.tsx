import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Login } from "~/pages/Login";
import { Home } from "~/pages/Home";

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
      <Route
        path="/"
        element={
          <Protected session={session}>
            <Home />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
