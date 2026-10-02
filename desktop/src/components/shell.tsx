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
import { FRAME_LIGHT_AIM, StageLight } from "@/components/stage-light";
import { cn } from "@/lib/utils";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ErrorMonitor, AppErrorBoundary } from "@/components/error-monitor";
import { FeedbackUnreadProvider } from "@/components/feedback-button";
import { AccountButton, AccountPanel, AccountPanelProvider } from "@/components/account-panel";
import { isImmersivePath } from "@/components/chrome-gate";
import { IMMERSIVE_MAIN_CLASS } from "@/components/app-main";
import { accountLine } from "@/lib/role-label";
import { canEditAnyGroup } from "@/lib/permissions";
import { MgmtSyncStatus } from "~/components/mgmt-sync-status";
import { QuickShowLink } from "~/components/quick-show-link";
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
    // The sign-in screen's wrapper (relative isolate + bg-background + the page light
    // as the first element — see ~/pages/Login and App.tsx's BootScreen).
    <div
      data-cueiq-screen="shell-fallback"
      data-cueiq-failed={failed ? "1" : "0"}
      className="relative isolate grid min-h-screen place-items-center bg-background p-4"
    >
      <StageLight />
      <SkinRefresher />
      <div className="w-full max-w-sm space-y-3">
        <div className="slab rounded-[3px] p-6 text-center">
          <h1 className="flex justify-center">
            <HeaderBrand />
          </h1>
          <p className="mt-3 text-[14px] text-muted-foreground">
            {failed ? "โหลดข้อมูลไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา" : "กำลังโหลด…"}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={onRetry}>
              ลองใหม่
            </Button>
            {failed && <SignOutButton />}
          </div>
        </div>
        {/* Same Quick Show entry as the login + boot screens (see ~/pages/Login). */}
        <QuickShowLink />
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
    // FRAME_LIGHT_AIM: from lg up the light aims at the left-aligned page title, as on
    // the web frame (components/stage-light.tsx).
    // [--header-h:56px]: the header row below is h-14, not the theme's 52px phone
    // header — anything sticky under it (the Event page's tab row) sticks at this.
    <FeedbackUnreadProvider userId={userId}>
      <AccountPanelProvider>
        <div
          data-cueiq-screen="shell"
          data-cueiq-tenant={ws.tenant?.name ?? ""}
          className={cn(
            "relative isolate min-h-screen bg-background [--header-h:56px] [--tabbar-h:0px]",
            FRAME_LIGHT_AIM
          )}
        >
          {/* The page light (v3 Stage Wash), first, as on the web frame. Live Mode and
              the show-caller hang their own inside their root — one per document. */}
          {!immersive && <StageLight />}
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
            // No header to host the offline strip on the immersive screens. The
            // management outbox's auto-flush lived in that header (MgmtSyncStatus), so
            // it is mounted here headless — otherwise queued setlist/schedule edits sat
            // unsynced for as long as Live or the caller stayed open (shell.test.tsx).
            <>
              <OfflineBanner />
              <MgmtSyncStatus headless />
            </>
          ) : (
            <header className="no-print glass glass-top sticky top-0 z-40">
              <div className="container flex h-14 items-center gap-4">
                <Link to="/dashboard" className="flex h-11 shrink-0 items-center rounded-[3px]">
                  <HeaderBrand />
                </Link>
                {/* The desktop has no tab bar, so the nav is inline at every width
                    and scrolls sideways in a narrow window — with its scrollbar
                    hidden: a classic 15px bar inside the 56px header pushed the pills
                    7px up and painted across them (Windows; overlay bars hide
                    themselves). py-1 stays: the pills' 44px hit area reaches 4px past
                    them and the scroller would clip it. */}
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <MainNav perms={ws.perms} />
                </div>
                {/* QUICK SHOW — the local standalone runner; also reachable when logged
                    in. A sibling of the scroller, not inside it, so a narrow window
                    scrolls the destinations and never carries this one off screen. */}
                <Link
                  to="/my-show"
                  className="caps flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-3 text-[14px] leading-none text-primary-ink shadow-[inset_0_0_0_1.5px_hsl(var(--primary)/.5)] transition-colors duration-2 hover:bg-primary/10"
                  title="Quick Show — โหมดโชว์เดี่ยว เปิดเพลง+จับเวลาจากไฟล์ในเครื่องนี้ (ออฟไลน์ 100%)"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden /> Quick Show
                </Link>
                <MgmtSyncStatus />
                <AccountButton name={name} />
              </div>
              <OfflineBanner placement="header" />
            </header>
          )}
          {/* Immersive: no container and no padding — the show screens are edge to
              edge and own their gutter (the web's components/app-main.tsx). */}
          <main className={immersive ? IMMERSIVE_MAIN_CLASS : "container relative z-[1] overflow-x-clip py-6"}>
            {userId ? (
              // A render crash used to leave the desktop on a blank window with no
              // reload and nothing logged — mid-show, on the machine wired to the PA.
              // hashRoute: on Live / the show-caller (no header) its card adds the way
              // back to the event and Quick Show (components/error-monitor.tsx).
              <AppErrorBoundary userId={userId} tenantId={tenantId} hashRoute={pathname}>
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
