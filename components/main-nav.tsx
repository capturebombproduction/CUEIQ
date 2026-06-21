"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isAdmin, isLabelWideUser, type Perms } from "@/lib/permissions";

type NavLink = { href: string; label: string; short: string };

const LINKS: NavLink[] = [
  { href: "/dashboard", label: "Events", short: "Events" },
  { href: "/overview", label: "Overview", short: "Overview" },
  { href: "/library", label: "Music Library", short: "Library" },
  { href: "/practice", label: "Training", short: "Training" },
  { href: "/groups", label: "Artists", short: "Artists" },
];

export function MainNav({ perms }: { perms?: Perms }) {
  const pathname = usePathname();
  // /overview is a label-wide surface; /admin is admin-only. label_staff is
  // overview-only for events, so they don't get the /dashboard ("Events") link —
  // overview becomes their first/primary tab. Hide what a role can't use (RLS
  // still enforces — this just declutters the nav).
  const labelStaff = perms?.tenantRole === "label_staff";
  const links: NavLink[] = LINKS.filter((l) => {
    if (l.href === "/overview") return !!perms && isLabelWideUser(perms);
    if (l.href === "/dashboard") return !labelStaff;
    if (l.href === "/practice") return !labelStaff; // practice is a band activity
    return true;
  });
  if (perms && isAdmin(perms)) {
    links.push({ href: "/admin", label: "Admin", short: "Admin" });
  }
  return (
    <nav className="flex items-center gap-1">
      {links.map((link) => {
        const active =
          pathname === link.href || pathname.startsWith(link.href + "/");
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "rounded-md px-2 py-1.5 text-sm font-medium transition-colors sm:px-3",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            <span className="sm:hidden">{link.short}</span>
            <span className="hidden sm:inline">{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
