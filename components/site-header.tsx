import Link from "next/link";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/sign-out-button";
import { ChangePasswordButton } from "@/components/change-password-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { MainNav } from "@/components/main-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccentPicker } from "@/components/accent-picker";
import { InstallButton } from "@/components/install-button";
import { ROLE_SHORT, type Role } from "@/lib/types";
import { isLabelWideUser, type Perms } from "@/lib/permissions";

/**
 * What role to show in the header. Band-scoped accounts all carry an inert
 * tenant role of `member`, so for them we surface their REAL per-band role
 * (Ar if they manage any band, otherwise สมาชิก) instead of the misleading
 * tenant label. Label-wide accounts (admin/ceo/label_staff) show the tenant role.
 */
function roleLabel(role: Role | null | undefined, perms?: Perms): string | null {
  if (perms && !isLabelWideUser(perms) && perms.groupRoles.length > 0) {
    return perms.groupRoles.some((g) => g.role === "artist_manager") ? "Ar" : "สมาชิก";
  }
  return role ? ROLE_SHORT[role] : null;
}

export function SiteHeader({
  name,
  role,
  perms,
  userId,
  tenantId,
}: {
  name?: string | null;
  role?: Role | null;
  perms?: Perms;
  userId?: string | null;
  tenantId?: string | null;
}) {
  const shownRole = roleLabel(role, perms);
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
          {shownRole && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {shownRole}
            </Badge>
          )}
          {name && (
            <span className="hidden max-w-[16ch] truncate text-sm font-medium md:inline">
              {name}
            </span>
          )}
          {userId && tenantId && (
            <NotificationBell userId={userId} tenantId={tenantId} />
          )}
          <InstallButton />
          <AccentPicker />
          <ThemeToggle />
          <ChangePasswordButton />
          <SignOutButton />
        </div>
      </div>
      {/* mobile nav row — keeps all links visible without overflowing the header.
          Identity (role + name) lives here on phones since the top row hides it. */}
      <div className="container -mt-1 space-y-1.5 pb-2 md:hidden">
        {(shownRole || name) && (
          <div className="flex items-center gap-2 text-xs">
            {shownRole && (
              <Badge variant="secondary" className="text-[10px]">
                {shownRole}
              </Badge>
            )}
            {name && (
              <span className="min-w-0 truncate font-medium">{name}</span>
            )}
          </div>
        )}
        <div className="overflow-x-auto">
          <MainNav perms={perms} />
        </div>
      </div>
    </header>
  );
}
