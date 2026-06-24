// Shim: map next/navigation onto react-router so reused web client components keep
// working unchanged in the desktop SPA. Covers the APIs the app actually uses.
import {
  useNavigate,
  useLocation,
  useParams as rrUseParams,
  useSearchParams as rrUseSearchParams,
} from "react-router-dom";

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    // No SSR cache to bust in a SPA — data re-loads via effects on navigation.
    refresh: () => {},
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
