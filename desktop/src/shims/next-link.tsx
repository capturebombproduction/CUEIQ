// Shim: next/link → react-router Link (maps `href` → `to`, drops Next-only props).
import { Link as RRLink } from "react-router-dom";
import type { ComponentProps, ReactNode } from "react";

type NextLinkProps = {
  href: string;
  children: ReactNode;
  replace?: boolean;
  // Next-only props we accept-and-ignore so spreads don't break:
  prefetch?: boolean;
  scroll?: boolean;
} & Omit<ComponentProps<typeof RRLink>, "to" | "replace">;

export default function Link({
  href,
  children,
  replace,
  prefetch: _prefetch,
  scroll: _scroll,
  ...rest
}: NextLinkProps) {
  return (
    <RRLink to={href} replace={replace} {...rest}>
      {children}
    </RRLink>
  );
}
