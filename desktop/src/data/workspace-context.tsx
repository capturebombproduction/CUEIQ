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
import { loadWorkspace, type WorkspaceData } from "~/data/workspace";

type WorkspaceCtx = {
  loading: boolean;
  ws: WorkspaceData | null;
  reload: () => void;
};

const Ctx = createContext<WorkspaceCtx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ loading: boolean; ws: WorkspaceData | null }>({
    loading: true,
    ws: null,
  });

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    loadWorkspace()
      .then((ws) => setState({ loading: false, ws }))
      .catch(() => setState({ loading: false, ws: null }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return <Ctx.Provider value={{ ...state, reload }}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within <WorkspaceProvider>");
  return ctx;
}
