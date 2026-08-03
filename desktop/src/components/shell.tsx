// Desktop app shell — the authenticated frame around every routed page. Mirrors
// the web SiteHeader (Brand + MainNav + identity + theme/sign-out), reusing the
// same components so it looks identical, and wraps the routed Outlet in the same
// ConfirmProvider the web (app)/layout provides (delete buttons call useConfirm).
import { Link, Outlet } from "react-router-dom";
import { Play } from "lucide-react";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MainNav } from "@/components/main-nav";
import { AccentPicker } from "@/components/accent-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { OfflineBanner } from "@/components/offline-banner";
import { OutboxFlusher } from "@/components/outbox-flusher";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ErrorMonitor, AppErrorBoundary } from "@/components/error-monitor";
import { FeedbackButton } from "@/components/feedback-button";
import { ROLE_SHORT, type Role } from "@/lib/types";
import { isLabelWideUser, type Perms } from "@/lib/permissions";
import { MgmtSyncStatus } from "~/components/mgmt-sync-status";
import { useWorkspace } from "~/data/workspace-context";

/** Same rule as the web header: band-scoped accounts show their REAL per-band role
 *  (Ar / สมาชิก) rather than the inert tenant `member` label. */
function roleLabel(role: Role | null | undefined, perms?: Perms): string | null {
  if (perms && !isLabelWideUser(perms) && perms.groupRoles.length > 0) {
    return perms.groupRoles.some((g) => g.role === "artist_manager") ? "Ar" : "สมาชิก";
  }
  return role ? ROLE_SHORT[role] : null;
}

/** Escape hatch shown while the workspace is loading and when it failed to load.
 *  Same reasoning as App.tsx's BootScreen: a venue network that is joined but
 *  black-holed makes this screen stretch, and a failed load used to render the
 *  bare "กำลังโหลด…" FOREVER (`loading || !ws`) with no retry and no way to reach
 *  Quick Show — the one runner that needs neither network nor login. */
function ShellFallback({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 p-4">
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

  if (loading || !ws) {
    return <ShellFallback failed={!loading} onRetry={reload} />;
  }

  const name = ws.user?.name ?? null;
  const role = ws.membership?.role ?? null;
  const shownRole = roleLabel(role, ws.perms);
  const userId = ws.user?.id ?? null;
  const tenantId = ws.membership?.tenant_id ?? null;

  return (
    <div className="min-h-screen bg-muted/30">
      {/* The web app has captured its own client errors and carried a แจ้งปัญหา
          button since round 2; the desktop shipped with NEITHER — and the desktop
          is the copy that goes to the venue, so the one place a real bug happens
          was the one place nothing recorded it and nobody could report it without
          leaving the room. Same three shared components, same tables. */}
      {userId && <ErrorMonitor userId={userId} tenantId={tenantId} />}
      <OfflineBanner />
      <OutboxFlusher />
      <header className="no-print sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2">
          <Link to="/dashboard" className="shrink-0">
            <Brand subtitle="Desktop · Designed by PatzNutthapat" />
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
            <MgmtSyncStatus />
            <AccentPicker />
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
        <div className="container -mt-1 space-y-1.5 pb-2">
          {(shownRole || name) && (
            <div className="flex items-center gap-2 text-xs sm:hidden">
              {shownRole && (
                <Badge variant="secondary" className="text-[10px]">
                  {shownRole}
                </Badge>
              )}
              {name && <span className="min-w-0 truncate font-medium">{name}</span>}
            </div>
          )}
          <div className="flex items-center gap-2 overflow-x-auto">
            <MainNav perms={ws.perms} />
            {/* QUICK SHOW — the local standalone runner; also reachable when logged in */}
            <Link
              to="/my-show"
              className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-sm font-semibold text-primary transition-colors hover:bg-primary/20"
              title="Quick Show — โหมดโชว์เดี่ยว เปิดเพลง+จับเวลาจากไฟล์ในเครื่องนี้ (ออฟไลน์ 100%)"
            >
              <Play className="h-3.5 w-3.5" /> Quick Show
            </Link>
          </div>
        </div>
      </header>
      <main className="container py-6">
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
      {userId && <FeedbackButton userId={userId} tenantId={tenantId} floating />}
    </div>
  );
}
