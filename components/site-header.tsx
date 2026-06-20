import Link from "next/link";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/sign-out-button";
import { ChangePasswordButton } from "@/components/change-password-button";
import { MainNav } from "@/components/main-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccentPicker } from "@/components/accent-picker";
import { InstallButton } from "@/components/install-button";
import { ROLE_SHORT, type Role } from "@/lib/types";
import { type Perms } from "@/lib/permissions";

export function SiteHeader({
  name,
  role,
  perms,
}: {
  name?: string | null;
  role?: Role | null;
  perms?: Perms;
}) {
  return (
    <header className="no-print sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link href="/dashboard" className="shrink-0">
            <Brand subtitle="Designed by PatzNutthapat" />
          </Link>
          {/* nav is inline here on desktop; on mobile it drops to its own row below */}
          <div className="hidden md:block">
            <MainNav perms={perms} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
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
          <InstallButton />
          <AccentPicker />
          <ThemeToggle />
          <ChangePasswordButton />
          <SignOutButton />
        </div>
      </div>
      {/* mobile nav row — keeps all links visible without overflowing the header */}
      <div className="container -mt-1 pb-2 md:hidden">
        <div className="overflow-x-auto">
          <MainNav perms={perms} />
        </div>
      </div>
    </header>
  );
}
