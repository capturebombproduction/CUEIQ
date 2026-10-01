import { NotificationBell } from "@/components/notifications/notification-bell";
import { MainNav } from "@/components/main-nav";
import { InstallButton } from "@/components/install-button";
import { HeaderLead } from "@/components/header-brand";
import { AccountButton } from "@/components/account-panel";
import { OfflineBanner } from "@/components/offline-banner";
import type { Perms } from "@/lib/permissions";

/**
 * The app header (FINAL-SPEC-v2 §F.1): ONE glass row on every screen size.
 *
 * Below lg: wordmark (or "‹ EVENTS" on a show page) · install · bell. The nav is
 * the bottom tab bar there, and everything else the header used to hold — theme,
 * band colour, fullscreen, password, sign-out — lives in the More sheet
 * (components/account-panel.tsx). On a 390px phone the header was four sticky rows
 * and 167px on 2026-10-01, then two behind a "⋯"; it is one row of 52px now.
 *
 * lg and up (an iPad in landscape included): wordmark · inline nav · install ·
 * bell · avatar, and the avatar opens the same panel the More tab does.
 *
 * The bell and install NEVER fold away: the bell is how feedback replies and show
 * reminders are seen, and installing is the step push needs on an iPhone (push
 * reached 1 of 19 accounts when that was measured). site-header.test.tsx pins it.
 *
 * The offline strip is the header's second row while offline, so it pushes the
 * page down instead of covering the header (it used to be a fixed overlay).
 */
export function SiteHeader({
  name,
  perms,
  userId,
  tenantId,
}: {
  name?: string | null;
  perms?: Perms;
  userId?: string | null;
  tenantId?: string | null;
}) {
  return (
    <header className="no-print glass glass-top sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
      <div className="flex h-[var(--header-h)] items-center gap-2 pl-4 pr-2 lg:container lg:h-14 lg:gap-5 lg:px-4">
        <HeaderLead perms={perms} />
        <div className="hidden min-w-0 overflow-x-auto py-1 lg:block">
          <MainNav perms={perms} />
        </div>
        <div className="ml-auto flex shrink-0 items-center">
          <InstallButton />
          {userId && tenantId && <NotificationBell userId={userId} tenantId={tenantId} />}
          <AccountButton name={name} className="ml-1 hidden lg:grid" />
        </div>
      </div>
      <OfflineBanner placement="header" />
    </header>
  );
}
