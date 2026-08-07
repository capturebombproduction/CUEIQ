"use client";

import { usePathname } from "next/navigation";
import { describeDeadEnd } from "@/lib/dead-link";
import { DeadEndPage } from "../not-found";

// notFound() thrown inside the authenticated app (a deleted event, a show that
// belongs to another band) must land on the SAME Thai 404 as the rest of the
// product — but rendered INSIDE app/(app)/layout.tsx, so the header, the nav and
// the bell stay on screen and the user is one tap from anywhere. A not-found
// boundary only preserves the layouts ABOVE its own segment, so the root
// app/not-found.tsx alone would strip the shell off every in-app dead end.
//
// This boundary — and ONLY this one — picks the copy from the path. It is reached
// by a notFound() thrown from a dynamically rendered page, so the server renders it
// per request with the real pathname and the client hydrates onto the same words.
// The root boundary cannot do that: it is served from a static prerender made with
// the pathname `/_not-found`, so reading usePathname() there hydrated to different
// Thai copy than was shipped. See the long note in ../not-found.tsx.
//
// Still one page and one set of Thai strings: the body is the shared DeadEndPage
// and the wording is describeDeadEnd() in lib/dead-link.ts. Do not copy either.
export default function AppNotFound() {
  return <DeadEndPage deadEnd={describeDeadEnd(usePathname())} />;
}
