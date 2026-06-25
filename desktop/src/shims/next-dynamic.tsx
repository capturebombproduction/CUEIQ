// Shim: map next/dynamic onto React.lazy so reused web client components that
// code-split their heavy children (e.g. EventWorkspace's per-tab editors) keep
// working unchanged in the desktop SPA.
//
// Every call site in this codebase uses the form
//   dynamic(() => import("…").then((m) => m.Named), { ssr: false, loading })
// so the loader resolves to the COMPONENT itself (not a module). We wrap it back
// into the `{ default }` shape React.lazy expects and render it under Suspense
// with the provided `loading` fallback. `ssr` is irrelevant in a pure SPA.
import {
  lazy,
  Suspense,
  createElement,
  type ComponentType,
  type ReactNode,
} from "react";

type Loader<P> = () => Promise<ComponentType<P>>;
type DynamicOptions = { ssr?: boolean; loading?: () => ReactNode };

export default function dynamic<P extends object>(
  loader: Loader<P>,
  options: DynamicOptions = {}
): ComponentType<P> {
  const Lazy = lazy(() => loader().then((C) => ({ default: C })));
  const Loading = options.loading;
  return function DynamicComponent(props: P) {
    return createElement(
      Suspense,
      { fallback: Loading ? createElement(Loading as ComponentType) : null },
      createElement(Lazy as ComponentType<P>, props)
    );
  };
}
