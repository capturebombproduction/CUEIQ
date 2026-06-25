// Desktop app shell — the authenticated frame around every routed page. Mirrors
// the web SiteHeader (Brand + MainNav + identity + theme/sign-out), reusing the
// same components so it looks identical, and wraps the routed Outlet in the same
// ConfirmProvider the web (app)/layout provides (delete buttons call useConfirm).
import { Link, Outlet } from "react-router-dom";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { MainNav } from "@/components/main-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ROLE_SHORT, type Role } from "@/lib/types";
import { isLabelWideUser, type Perms } from "@/lib/permissions";
import { useWorkspace } from "~/data/workspace-context";

/** Same rule as the web header: band-scoped accounts show their REAL per-band role
 *  (Ar / สมาชิก) rather than the inert tenant `member` label. */
function roleLabel(role: Role | null | undefined, perms?: Perms): string | null {
  if (perms && !isLabelWideUser(perms) && perms.groupRoles.length > 0) {
    return perms.groupRoles.some((g) => g.role === "artist_manager") ? "Ar" : "สมาชิก";
  }
  return role ? ROLE_SHORT[role] : null;
}

export function Shell() {
  const { loading, ws } = useWorkspace();

  if (loading || !ws) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 text-muted-foreground">
        กำลังโหลด…
      </div>
    );
  }

  const name = ws.user?.name ?? null;
  const role = ws.membership?.role ?? null;
  const shownRole = roleLabel(role, ws.perms);

  return (
    <div className="min-h-screen bg-muted/30">
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
          <div className="overflow-x-auto">
            <MainNav perms={ws.perms} />
          </div>
        </div>
      </header>
      <main className="container py-6">
        <ConfirmProvider>
          <Outlet />
        </ConfirmProvider>
      </main>
    </div>
  );
}
