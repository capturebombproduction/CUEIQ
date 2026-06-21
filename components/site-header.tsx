import Link from "next/link";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/sign-out-button";
import { ChangePasswordButton } from "@/components/change-password-button";
import { FeedbackButton } from "@/components/feedback-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { MainNav } from "@/components/main-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { AccentPicker } from "@/components/accent-picker";
import { InstallButton } from "@/components/install-button";
import { KioskMode } from "@/components/kiosk-mode";
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
      <div className="container flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2 xl:h-14 xl:flex-nowrap xl:py-0">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link href="/dashboard" className="shrink-0">
            <Brand subtitle="Designed by PatzNutthapat" />
          </Link>
          {/* nav is inline only on wide desktops (xl+), where even the admin's
              6-link nav fits beside the action icons; on anything narrower (phones in
              either orientation, tablets, split windows) it drops to its own
              scrollable row below so it can never overlap the action icons */}
          <div className="hidden xl:block">
            <MainNav perms={perms} />
          </div>
        </div>
        {/* action icons: inline beside the brand on wide desktops (xl+); on anything
            narrower the whole cluster (w-full) wraps onto its own right-aligned line
            below the brand so it can never overlap the logo, and flex-wraps again on
            very narrow phones instead of being clipped */}
        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5 sm:gap-x-3 xl:w-auto xl:flex-nowrap">
          {shownRole && (
            <Badge variant="secondary" className="hidden xl:inline-flex">
              {shownRole}
            </Badge>
          )}
          {name && (
            <span className="hidden max-w-[16ch] truncate text-sm font-medium xl:inline">
              {name}
            </span>
          )}
          {userId && tenantId && (
            <NotificationBell userId={userId} tenantId={tenantId} />
          )}
          <InstallButton />
          <KioskMode />
          <AccentPicker />
          <ThemeToggle />
          <FeedbackButton userId={userId} tenantId={tenantId} />
          <ChangePasswordButton />
          <SignOutButton />
        </div>
      </div>
      {/* mobile / landscape-phone / tablet nav row — keeps all links visible without
          overflowing the header (shown below xl). Identity (role + name) lives here
          since the top row hides it until xl. */}
      <div className="container -mt-1 space-y-1.5 pb-2 xl:hidden">
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
