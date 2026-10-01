"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  isAdmin,
  isLabelWideUser,
  canApprove,
  canViewOverview,
  canViewLibrary,
  type Perms,
} from "@/lib/permissions";

export type NavLink = { href: string; label: string };

const LINKS: NavLink[] = [
  { href: "/dashboard", label: "Events" },
  { href: "/overview", label: "Overview" },
  { href: "/library", label: "Library" },
  { href: "/practice", label: "Training" },
  { href: "/groups", label: "Artists" },
];

/** The destinations a role can use, in display order. */
export function navLinksFor(perms?: Perms): NavLink[] {
  // /overview: label-wide users see all bands, a band member sees only their own
  // (the page scopes it). /admin is admin-only. label_staff is overview-only for
  // events, so they don't get the /dashboard ("Events") link — overview becomes
  // their first/primary tab. Hide what a role can't use (RLS still enforces —
  // this just declutters the nav).
  const labelStaff = perms?.tenantRole === "label_staff";
  const links: NavLink[] = LINKS.filter((l) => {
    if (l.href === "/overview") return !!perms && canViewOverview(perms);
    if (l.href === "/library") return !!perms && canViewLibrary(perms); // staff: no catalogue
    if (l.href === "/dashboard") return !labelStaff;
    if (l.href === "/practice") return !labelStaff; // practice is a band activity
    return true;
  });
  // Crew directory: admin + label_staff maintain it (RLS 0032). Its own tab now,
  // not a collapsed block on /overview.
  if (perms && canApprove(perms)) {
    links.push({ href: "/crew", label: "Crew" });
  }
  if (perms && isAdmin(perms)) {
    links.push({ href: "/admin", label: "Admin" });
  }
  return links;
}

/**
 * Which of `hrefs` the current page belongs to. A plain prefix match left every
 * show page dark: a show lives at /events/<id>, which is not under /dashboard, so
 * "Events" never lit up where people spend their time. A show's practice room
 * counts as Training; any other show page counts as Events, or as Overview for
 * label staff, who have no Events link.
 */
export function activeNavHref(pathname: string, hrefs: string[]): string | null {
  const direct = hrefs
    .filter((h) => pathname === h || pathname.startsWith(h + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (direct) return direct;
  if (/^\/events\/[^/]+\/practice(\/|$)/.test(pathname) && hrefs.includes("/practice")) {
    return "/practice";
  }
  if (pathname === "/events" || pathname.startsWith("/events/")) {
    if (hrefs.includes("/dashboard")) return "/dashboard";
    if (hrefs.includes("/overview")) return "/overview";
  }
  return null;
}

/** The phone tab bar's last slot: opens a sheet, so it is not a route. */
export const MORE_HREF = "#more";

export type BottomTabs = { tabs: NavLink[]; more: NavLink[] };

const BOTTOM_TAB_SLOTS = 3;

/**
 * Which destinations earn a thumb slot, by who is holding the phone. Band people
 * live in their shows and rehearse from them; label-wide viewers (admin, CEO)
 * read across every band; label staff proof from Overview and keep the artist
 * and crew records. Hrefs a role cannot use are dropped by bottomTabsFor, so a
 * list here can never put a link in front of someone who may not open it.
 */
function tabPriority(perms?: Perms): string[] {
  if (perms?.tenantRole === "label_staff") return ["/overview", "/groups", "/crew"];
  if (perms && isLabelWideUser(perms)) return ["/dashboard", "/overview", "/library"];
  return ["/dashboard", "/practice", "/library"];
}

/**
 * The phone bottom bar: up to three tabs plus More, and everything else in the
 * More sheet. Built from navLinksFor so the bar and the desktop nav always offer
 * the same set — only the arrangement differs. If a priority destination is not
 * available to this account (a band user with no band yet has no Library), the
 * slot goes to the next link in nav order rather than staying empty.
 */
export function bottomTabsFor(perms?: Perms): BottomTabs {
  const links = navLinksFor(perms);
  const preferred = tabPriority(perms)
    .map((href) => links.find((l) => l.href === href))
    .filter((l): l is NavLink => !!l);
  const picked = [...preferred, ...links.filter((l) => !preferred.includes(l))].slice(
    0,
    BOTTOM_TAB_SLOTS
  );
  // Feedback is not a nav link — it is reached from the floating แจ้งปัญหา button
  // and the bell. The More sheet gives it a fixed place on the phone as well.
  const more = [
    ...links.filter((l) => !picked.includes(l)),
    { href: "/feedback", label: "Feedback" },
  ];
  return { tabs: [...picked, { href: MORE_HREF, label: "More" }], more };
}

/**
 * The tab to light. Same page→destination rules as activeNavHref (a show page is
 * Events, its practice room is Training), then: if that destination sits in the
 * More sheet, More lights — otherwise someone on /admin sees no tab lit and
 * cannot tell where they are.
 */
export function activeTabHref(pathname: string, layout: BottomTabs): string | null {
  const destinations = [...layout.tabs, ...layout.more]
    .map((l) => l.href)
    .filter((h) => h !== MORE_HREF);
  const hit = activeNavHref(pathname, destinations);
  if (!hit) return null;
  return layout.tabs.some((t) => t.href === hit) ? hit : MORE_HREF;
}

export function MainNav({ perms }: { perms?: Perms }) {
  const pathname = usePathname();
  const links = navLinksFor(perms);
  const activeHref = activeNavHref(pathname, links.map((l) => l.href));
  return (
    <nav className="flex items-center gap-1">
      {links.map((link) => {
        const active = link.href === activeHref;
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
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
