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
import { KioskMode } from "@/components/kiosk-mode";
import { HeaderTray } from "@/components/header-tray";
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
      {/* Brand + identity + action icons. The nav is NOT inline here: with the
          admin's 7-link nav (incl. Crew) it never reliably fit beside the icons — it
          overflowed around 1280–1700 and the role badge overlapped the nav — so the
          nav always sits on its own scrollable row below. On a phone the top row is
          brand + bell + "⋯" (the other tools fold into HeaderTray), so the sticky
          header is two rows, not four; from sm up everything sits on the one row. */}
      {/* sm:justify-end: when a long name pushes the tools onto a second row
          (≈640–760px), that row sits right, under the bell, not stranded left.
          The first row is unaffected — the cluster's ml-auto takes the space. */}
      <div className="container flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2 sm:justify-end sm:gap-x-3">
        <Link href="/dashboard" className="shrink-0">
          <Brand subtitle="Designed by PatzNutthapat" />
        </Link>
        {/* Always on the top row: who you are (sm+), the bell, and — when the
            browser offers it — install. The rest folds behind "⋯" on a phone
            (components/header-tray.tsx). */}
        <div className="ml-auto flex items-center gap-x-2 sm:gap-x-3">
          {shownRole && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {shownRole}
            </Badge>
          )}
          {name && (
            <span className="hidden max-w-[16ch] truncate text-sm font-medium sm:inline">
              {name}
            </span>
          )}
          {userId && tenantId && (
            <NotificationBell userId={userId} tenantId={tenantId} />
          )}
          <InstallButton />
        </div>
        <HeaderTray
          identity={
            shownRole || name ? (
              <>
                {shownRole && (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {shownRole}
                  </Badge>
                )}
                {name && <span className="min-w-0 truncate font-medium">{name}</span>}
              </>
            ) : undefined
          }
        >
          <KioskMode />
          <AccentPicker />
          <ThemeToggle />
          <ChangePasswordButton />
          <SignOutButton />
        </HeaderTray>
      </div>
      {/* Nav — always its own scrollable row, so it can never overlap the icons. */}
      <div className="container -mt-1 pb-2">
        <div className="overflow-x-auto">
          <MainNav perms={perms} />
        </div>
      </div>
    </header>
  );
}
