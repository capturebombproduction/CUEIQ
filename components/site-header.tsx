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
      {/* Brand + identity + action icons. The nav is NOT inline here: with the
          admin's 7-link nav (incl. Crew) it never reliably fit beside the icons — it
          overflowed around 1280–1700 and the role badge overlapped the nav — so the
          nav always sits on its own scrollable row below. The icon cluster is w-full
          on phones (its own right-aligned line under the brand) and auto from sm up
          (beside the brand on one row, with room to spare since the nav isn't here). */}
      <div className="container flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2">
        <Link href="/dashboard" className="shrink-0">
          <Brand subtitle="Designed by PatzNutthapat" />
        </Link>
        <div className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1.5 sm:w-auto sm:gap-x-3">
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
          <KioskMode />
          <AccentPicker />
          <ThemeToggle />
          <FeedbackButton userId={userId} tenantId={tenantId} />
          <ChangePasswordButton />
          <SignOutButton />
        </div>
      </div>
      {/* Nav — always its own scrollable row, so it can never overlap the icons.
          On phones (where the top row hides the identity) the role + name show here. */}
      <div className="container -mt-1 space-y-1.5 pb-2">
        {(shownRole || name) && (
          <div className="flex items-center gap-2 text-xs sm:hidden">
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
