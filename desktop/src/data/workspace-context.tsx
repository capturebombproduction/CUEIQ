// Loads the signed-in user's workspace once and shares it across the shell + pages
// (mirrors how the web (app)/layout resolves getWorkspace and passes it down).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { COLD_OFFLINE, loadWorkspace, type WorkspaceData } from "~/data/workspace";

type WorkspaceCtx = {
  loading: boolean;
  ws: WorkspaceData | null;
  /** The load failed because this machine is offline and has nothing of the account
   *  cached yet (see COLD_OFFLINE) - the Shell asks for the network once. */
  coldOffline?: boolean;
  reload: () => void;
};

const Ctx = createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    loading: boolean;
    ws: WorkspaceData | null;
    coldOffline: boolean;
  }>({
    loading: true,
    ws: null,
    coldOffline: false,
  });

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    loadWorkspace()
      .then((ws) => setState({ loading: false, ws, coldOffline: false }))
      .catch((e: unknown) =>
        setState({
          loading: false,
          ws: null,
          coldOffline: e instanceof Error && e.message === COLD_OFFLINE,
        })
      );
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // A load that failed retries by itself when the network comes back, so a first launch
  // at the venue fills in the moment someone joins the wifi - no hunting for ลองใหม่.
  const failed = !state.loading && !state.ws;
  useEffect(() => {
    if (!failed) return;
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, [failed, reload]);

  return <Ctx.Provider value={{ ...state, reload }}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}
