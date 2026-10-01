"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AudioLines, ChevronLeft } from "lucide-react";
import { activeNavHref, navLinksFor } from "@/components/main-nav";
import { cn } from "@/lib/utils";
import type { Perms } from "@/lib/permissions";

/** The header wordmark: the band-coloured mark + "CUEIQ" in the italic display
 *  face, IQ in band ink. Shared by the web header and the desktop shell so the two
 *  apps cannot drift apart again. */
export function HeaderBrand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="brand-mark" aria-hidden>
        <AudioLines className="h-[17px] w-[17px]" strokeWidth={2.6} />
      </span>
      <span className="font-display-x text-[25px] font-extrabold uppercase italic leading-none tracking-[-.01em]">
        Cue<span className="text-primary-ink">IQ</span>
      </span>
    </span>
  );
}

/** A show and its sub-pages: where a phone header trades the wordmark for a way
 *  back. `/events/new` counts — it is reached from Events and returns there. */
const DETAIL = /^\/events\/[^/]+(?:\/(?:practice|edit|run-order))?\/?$/;

/**
 * The header's left slot. On a phone, a show page (and its practice room, editor
 * and running-order builder) shows "‹ EVENTS" / "‹ TRAINING" instead of the
 * wordmark: the tab bar says where you are, but not how to get back up, and the
 * browser's back button is absent in an installed app. The parent is the same
 * destination the tab bar lights (activeNavHref), so the two never disagree — a
 * label-staff account, which has no Events, goes back to Overview.
 *
 * From lg up the wordmark always shows: the inline nav sits right beside it and
 * already offers the way back.
 */
export function HeaderLead({ perms }: { perms?: Perms }) {
  const pathname = usePathname() ?? "";
  const links = navLinksFor(perms);
  const parentHref = DETAIL.test(pathname)
    ? activeNavHref(pathname, links.map((l) => l.href))
    : null;
  const parent = parentHref ? links.find((l) => l.href === parentHref) : undefined;

  return (
    <>
      {parent && (
        <Link
          href={parent.href}
          title={`กลับไป ${parent.label}`}
          className="caps -ml-2 flex h-11 shrink-0 items-center gap-0.5 rounded-[3px] pr-2 text-[19px] text-primary-ink lg:hidden"
        >
          <ChevronLeft className="h-6 w-6" strokeWidth={2.6} aria-hidden />
          {parent.label}
        </Link>
      )}
      <Link
        href="/dashboard"
        // h-11: the whole 44px row height is the tap target, not just the 30px mark.
        className={cn("h-11 shrink-0 items-center rounded-[3px]", parent ? "hidden lg:flex" : "flex")}
      >
        <HeaderBrand />
      </Link>
    </>
  );
}
