// Desktop app shell — the authenticated frame around every routed page. Mirrors
// the web header (wordmark + MainNav + the account panel behind an avatar), reusing
// the same components so it looks identical, and wraps the routed Outlet in the
// same ConfirmProvider the web (app)/layout provides (delete buttons call useConfirm).
import { Link, Outlet, useLocation } from "react-router-dom";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MainNav } from "@/components/main-nav";
import { HeaderBrand } from "@/components/header-brand";
import { SignOutButton } from "@/components/sign-out-button";
import { OfflineBanner } from "@/components/offline-banner";
import { OutboxFlusher } from "@/components/outbox-flusher";
import { SkinRefresher } from "@/components/skin-refresher";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ErrorMonitor, AppErrorBoundary } from "@/components/error-monitor";
import { FeedbackUnreadProvider } from "@/components/feedback-button";
import { AccountButton, AccountPanel, AccountPanelProvider } from "@/components/account-panel";
import { isImmersivePath } from "@/components/chrome-gate";
import { accountLine } from "@/lib/role-label";
import { canEditAnyGroup } from "@/lib/permissions";
import { MgmtSyncStatus } from "~/components/mgmt-sync-status";
import { useWorkspace } from "~/data/workspace-context";

/** Escape hatch shown while the workspace is loading and when it failed to load.
 *  Same reasoning as App.tsx's BootScreen: a venue network that is joined but
 *  black-holed makes this screen stretch, and a failed load used to render the
 *  bare "กำลังโหลด…" FOREVER (`loading || !ws`) with no retry and no way to reach
 *  Quick Show — the one runner that needs neither network nor login. */
function ShellFallback({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    // data-cueiq-screen — see the note on App.tsx's BootScreen. THIS one carries the
    // round's sharpest distinction: "shell" means the offline cache was honoured and
    // the app is usable, "shell-fallback" means signed in and showing nothing. They
    // are one Thai word apart on screen and a whole show apart in practice.
    <div
      data-cueiq-screen="shell-fallback"
      data-cueiq-failed={failed ? "1" : "0"}
      className="grid min-h-screen place-items-center bg-background p-4"
    >
      <SkinRefresher />
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-primary">CueIQ</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {failed ? "โหลดข้อมูลไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา" : "กำลังโหลด…"}
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            ลองใหม่
          </Button>
          {failed && <SignOutButton />}
        </div>
        {/* Same Quick Show entry as the login + boot screens (see ~/pages/Login). */}
        <Link
          to="/my-show"
          className="group flex items-center gap-3 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3 shadow-sm transition-colors hover:border-primary/70 hover:bg-primary/10"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors group-hover:bg-primary/25">
            <Play className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-primary">Quick Show</span>
            <span className="block text-xs text-muted-foreground">
              โหมดโชว์เดี่ยว — เปิดเพลง+จับเวลาจากเครื่องนี้ ไม่ต้องเข้าสู่ระบบ
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}

export function Shell() {
  const { loading, ws, reload } = useWorkspace();
  const { pathname } = useLocation();

  if (loading || !ws) {
    return <ShellFallback failed={!loading} onRetry={reload} />;
  }

  const name = ws.user?.name ?? null;
  const userId = ws.user?.id ?? null;
  const tenantId = ws.membership?.tenant_id ?? null;
  // Live Mode and the live show-caller are immersive here too: no header.
  const immersive = isImmersivePath(pathname);

  return (
    // data-cueiq-tenant is the offline self-test's proof that the workspace came
    // from the CACHE and not from empty(): loadWorkspace never returns null, so the
    // Shell renders either way and "we reached the shell" alone says nothing about
    // whether the band's data survived the drive to the venue. A name here means it
    // did.
    // [--tabbar-h:0px]: the desktop has no bottom tab bar, so nothing that floats
    // "above the tab bar" (the Library mini-player) may leave room for one.
    <FeedbackUnreadProvider userId={userId}>
      <AccountPanelProvider>
        <div
          data-cueiq-screen="shell"
          data-cueiq-tenant={ws.tenant?.name ?? ""}
          className="relative isolate min-h-screen bg-background [--tabbar-h:0px]"
        >
          {/* The web app has captured its own client errors since round 2; the
              desktop shipped with NEITHER that nor a way to report — and the desktop
              is the copy that goes to the venue, so the one place a real bug happens
              was the one place nothing recorded it and nobody could report it without
              leaving the room. Same shared components, same tables. Reporting is the
              Feedback tile in the account panel (no floating button — shell.test.tsx). */}
          {userId && <ErrorMonitor userId={userId} tenantId={tenantId} />}
          <SkinRefresher />
          <OutboxFlusher />
          {immersive ? (
            // No header to host the offline strip on the immersive screens.
            <OfflineBanner />
          ) : (
            <header className="no-print glass glass-top sticky top-0 z-40">
              <div className="container flex h-14 items-center gap-4">
                <Link to="/dashboard" className="flex h-11 shrink-0 items-center rounded-[3px]">
                  <HeaderBrand />
                </Link>
                {/* The desktop has no tab bar, so the nav is inline at every width
                    and scrolls sideways in a narrow window. */}
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1">
                  <MainNav perms={ws.perms} />
                  {/* QUICK SHOW — the local standalone runner; also reachable when logged in */}
                  <Link
                    to="/my-show"
                    className="caps flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-3 text-[14px] leading-none text-primary-ink shadow-[inset_0_0_0_1.5px_hsl(var(--primary)/.5)] transition-colors duration-2 hover:bg-primary/10"
                    title="Quick Show — โหมดโชว์เดี่ยว เปิดเพลง+จับเวลาจากไฟล์ในเครื่องนี้ (ออฟไลน์ 100%)"
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden /> Quick Show
                  </Link>
                </div>
                <MgmtSyncStatus />
                <AccountButton name={name} />
              </div>
              <OfflineBanner placement="header" />
            </header>
          )}
          <main className="container relative z-[1] overflow-x-clip py-6">
            {userId ? (
              // A render crash used to leave the desktop on a blank window with no
              // reload and nothing logged — mid-show, on the machine wired to the PA.
              <AppErrorBoundary userId={userId} tenantId={tenantId}>
                <ConfirmProvider>
                  <Outlet />
                </ConfirmProvider>
              </AppErrorBoundary>
            ) : (
              <ConfirmProvider>
                <Outlet />
              </ConfirmProvider>
            )}
          </main>
          {/* Same panel as the web's More sheet: theme, band colour, fullscreen,
              password, sign-out, What's New, Feedback. Destinations stay in the
              inline nav above, so the panel does not repeat them. */}
          <AccountPanel
            name={name}
            line={accountLine({
              role: ws.membership?.role ?? null,
              perms: ws.perms,
              groups: ws.groups,
              tenantName: ws.tenant?.name,
            })}
            perms={ws.perms}
            userId={userId}
            tenantId={tenantId}
            canEdit={canEditAnyGroup(ws.perms)}
            destinations="never"
          />
        </div>
      </AccountPanelProvider>
    </FeedbackUnreadProvider>
  );
}
