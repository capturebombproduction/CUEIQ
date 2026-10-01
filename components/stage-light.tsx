import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * THE page light (redesign v3 "Stage Wash", review-shots/design/FINAL-SPEC-v3.md
 * §E.11): one static wash hanging just above the screen — a hot core behind the
 * header and the title, a long soft throw down to the hero, and (dark only) a
 * vignette that sinks the lists into near-black. Its paint is `.spotlight` in
 * app/stage.css; this is only the element.
 *
 * ONE per document, as the FIRST child of its host:
 *  · the app frame for ordinary pages — `app/(app)/layout.tsx` (behind ChromeGate)
 *    and the desktop Shell;
 *  · the immersive Live screens inside their own root (live-mode.tsx,
 *    event-live-caller.tsx), aimed at the NOW column, because overtime swaps the
 *    light to the alarm light through `.zone-over` on that root;
 *  · the sign-in screens (web + desktop).
 *
 * It is `position: fixed` at `z-index: -1`, so its host must be (or sit in) a
 * stacking context with no opaque background between — `relative isolate` on the
 * app frame and the login screen, the immersive `<main>` (relative z-[1]) on Live —
 * and NO ancestor may carry transform / filter / perspective / contain /
 * will-change, which would turn "fixed" into "absolute to that box" (it would
 * scroll away and end in a seam). Never inside a node the JPG export captures.
 *
 * `x` aims the hot core inline; leave it out to aim with a class (Live's
 * `stage:[--spot-x:27%]`) or by inheritance (FRAME_LIGHT_AIM) — an inline value
 * would beat both.
 */
export function StageLight({ x, className }: { x?: string; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("spotlight no-print", className)}
      style={x ? ({ "--spot-x": x } as CSSProperties) : undefined}
    />
  );
}

/**
 * Where the app frames aim the light (`app/(app)/layout.tsx`, the desktop Shell) —
 * set on the FRAME, so everything lit inside it inherits one aim: the light, and the
 * Event page's sticky `.lit-bar`, which repeats it. From lg up a page's title sits at
 * the container's LEFT edge, and a light hung at 50 % put its 320 px hot core in the
 * empty space between the title and the right-hand meta, with the long throw as a
 * pale vertical stripe down the middle of the light theme. 25 % (320 px at 1280)
 * puts the title row inside the core. Not the mockup's 18 % (its wide panel had no
 * band-ink text at its top-left): there, the primary-ink "‹ TRAINING" back link at
 * the page's top-left sat in the hottest part and fell to 3.98–4.10:1 on the red and
 * pink bands (probe, dark); at 25 % it is ≥ 4.66 again. A page that is ONE centred
 * column (Training, the event form) marks its wrapper `data-stage-centred` and keeps
 * the light on its column. The Live screens inside a frame would inherit this too,
 * so their own StageLight states its base aim explicitly.
 */
export const FRAME_LIGHT_AIM = "lg:[--spot-x:25%] lg:[&:has([data-stage-centred])]:[--spot-x:50%]";
