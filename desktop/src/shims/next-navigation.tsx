// Shim: map next/navigation onto react-router so reused web client components keep
// working unchanged in the desktop SPA. Covers the APIs the app actually uses.
import {
  useNavigate,
  useLocation,
  useParams as rrUseParams,
  useSearchParams as rrUseSearchParams,
} from "react-router-dom";

// There is no SSR cache to bust in a SPA, but the reused web components call
// router.refresh() to mean "re-read the data" (after a write, and when the event
// workspace switches to its Summary tab). Leaving it a no-op made those surfaces
// — Summary, the completeness card, Print, the run-sheet image — render page-load
// data forever. So refresh() now fans out to whatever page is currently showing
// data; a page with no subscriber behaves exactly like the old stub.
const refreshListeners = new Set<() => void>();

/** Run `fn` whenever a component calls router.refresh(). Returns unsubscribe. */
export function onRouterRefresh(fn: () => void): () => void {
  refreshListeners.add(fn);
  return () => {
    refreshListeners.delete(fn);
  };
}

function emitRefresh() {
  // Iterate a copy — a listener that unsubscribes itself mid-loop must not make
  // the remaining listeners be skipped.
  for (const fn of [...refreshListeners]) fn();
}

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: emitRefresh,
    prefetch: () => {},
  };
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return rrUseParams() as T;
}

export function useSearchParams(): URLSearchParams {
  const [params] = rrUseSearchParams();
  return params;
}

export function redirect(href: string): never {
  window.location.assign(href);
  // satisfy the `never` contract used at call sites
  throw new Error("REDIRECT");
}

export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
