"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Compass, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeDeadEnd, type DeadEnd } from "@/lib/dead-link";

/**
 * The app's own 404. Until now every dead end in the whole product — a deleted
 * event opened from an old bell notification, a mistyped URL, a link to another
 * band's show that RLS won't let you read — rendered Next's bare English default:
 * a white page reading "404 | This page could not be found", with no way back and
 * nothing in Thai. On a phone at a venue that reads as "the app is broken".
 *
 * Two things this page is careful about:
 *
 * 1) IT DOES NOT PRETEND TO KNOW WHY. A not-found boundary is handed nothing but
 *    the URL. "The event was deleted" and "you may not see this band's event" are
 *    the same observation from here — events_select is can_view_group(group_id), so
 *    RLS answers both with no row and no error, and the page above called
 *    notFound() for both. So the copy names both possibilities where both are
 *    possible, and is definite only where it can be (a URL the product simply
 *    doesn't have). The wording lives in lib/dead-link.ts (describeDeadEnd) so it
 *    is unit-tested rather than eyeballed.
 *
 * 2) IT ALWAYS OFFERS A DOOR. This file is at the ROOT segment, so Next renders it
 *    inside app/layout.tsx only — the authenticated shell in app/(app)/layout.tsx,
 *    with its header and nav, is BELOW this boundary and is replaced. (That is why
 *    app/(app)/not-found.tsx exists: in-app dead ends then hit the boundary inside
 *    that layout and keep the header.) Either way the buttons below are the
 *    guaranteed way out, so never remove them.
 */
export function DeadEndPage({ deadEnd }: { deadEnd: DeadEnd }) {
  const router = useRouter();
  const { heading, detail, backHref, backLabel } = deadEnd;

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <div className="slab flex flex-col items-center gap-4 rounded-[3px] p-6 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-[2px] bg-muted text-muted-foreground">
          <SearchX className="h-6 w-6" aria-hidden />
        </span>
        <p className="num text-[64px] leading-[.8] text-faint" aria-hidden>
          404
        </p>
        <h1 className="text-xl font-semibold leading-snug">{heading}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{detail}</p>
        <div className="flex w-full flex-col gap-2 pt-1 sm:flex-row sm:justify-center">
          <Button asChild size="lg" className="min-w-0">
            <Link href={backHref}>
              <Compass aria-hidden /> <span className="truncate">{backLabel}</span>
            </Link>
          </Button>
          <Button variant="secondary" size="lg" onClick={() => router.back()}>
            <ArrowLeft aria-hidden /> ย้อนกลับ
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * WHY THIS BOUNDARY DOES NOT READ usePathname().
 *
 * `/_not-found` is a fully STATIC prerender (.next/prerender-manifest.json lists it
 * with initialStatus 404, and .next/server/app/_not-found.html is what Next serves
 * for every URL that matches no route). That HTML was rendered with the pathname
 * `/_not-found`, i.e. always the generic branch — but on the client Next seeds the
 * router from `location`, so usePathname() returns the REAL requested path during
 * hydration. Deriving the copy from it here therefore hydrated /admin/users to
 * "ไม่พบรายการนี้ … ไม่มีสิทธิ์เข้าถึง" over prerendered HTML that said
 * "ไม่พบหน้านี้ … ไม่มีหน้านี้ในระบบ": a React hydration mismatch (the subtree is
 * thrown away and re-rendered) and, worse, a flash of one message replaced by
 * another that disagrees about whether the user is locked out. Invisible in
 * `next dev`, where the 404 is rendered per request.
 *
 * The generic branch is not a compromise here, it is the correct answer: this
 * boundary is reached for URLs the product has no route for at all. A missing or
 * forbidden RECORD is always a notFound() thrown from a page under (app), and that
 * lands on app/(app)/not-found.tsx, which is dynamically rendered and so may read
 * the path. (app/share/[token] is the only page outside (app) that can dead-end and
 * it renders its own message rather than calling notFound().)
 */
export default function NotFound() {
  return <DeadEndPage deadEnd={describeDeadEnd(null)} />;
}
