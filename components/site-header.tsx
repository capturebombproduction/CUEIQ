import Link from "next/link";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/sign-out-button";
import { MainNav } from "@/components/main-nav";
import { ROLE_SHORT, type Role } from "@/lib/types";

export function SiteHeader({
  name,
  role,
  tenantName,
}: {
  name?: string | null;
  role?: Role | null;
  tenantName?: string | null;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-2 sm:gap-4">
          <Link href="/dashboard" className="shrink-0">
            <Brand subtitle="Designed by PatzNutthapat" />
          </Link>
          <MainNav />
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {tenantName && (
            <span className="hidden whitespace-nowrap text-sm text-muted-foreground md:inline">
              {tenantName}
            </span>
          )}
          {role && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {ROLE_SHORT[role]}
            </Badge>
          )}
          {name && (
            <span className="hidden max-w-[16ch] truncate text-sm font-medium md:inline">
              {name}
            </span>
          )}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
