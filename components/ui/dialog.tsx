"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { hasThai } from "@/lib/thai";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

// A flat scrim, no backdrop-blur: glass belongs to the two sticky bars only, and a
// blur under a sheet costs a full-screen repaint every frame on a mid-range phone.
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-[hsl(var(--scrim)/var(--scrim-a))] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * Notes what had focus the moment this dialog's content mounted, into `into`.
 *
 * Radix returns focus on close to its Trigger and ONLY to its Trigger (its handler
 * calls preventDefault, which switches its own "put it back where it was" off). A
 * dialog opened from state — a confirm, a row's edit sheet, anything without a
 * <DialogTrigger> — has no trigger, so Esc left focus on <body> and a keyboard user
 * restarted from the top of the page.
 *
 * Why a child rendered FIRST, with a layout effect, and not onOpenAutoFocus: Radix
 * only fires that when focus is not already inside the dialog, and a child with
 * `autoFocus` (the type-to-confirm field) has taken focus at commit, before Radix
 * looks. This runs in the same commit, ahead of any later sibling's autoFocus.
 */
function RememberOpener({ into }: { into: React.MutableRefObject<HTMLElement | null> }) {
  React.useLayoutEffect(() => {
    const el = document.activeElement;
    into.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }, [into]);
  return null;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onCloseAutoFocus, ...props }, ref) => {
  const opener = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        onCloseAutoFocus={(e) => {
          // The caller first: one that takes focus elsewhere says so with preventDefault
          // (a hand-over to another sheet, a field to return to) and is left alone.
          onCloseAutoFocus?.(e);
          const back = opener.current;
          opener.current = null;
          // Otherwise go back to what opened this. Radix runs right after and, when
          // there IS a Trigger, focuses that — the same element in the usual case.
          if (!e.defaultPrevented && back?.isConnected) back.focus({ preventScroll: true });
        }}
        className={cn(
          // Below sm a BOTTOM SHEET (thumb reach, the iOS idiom); from sm a centred panel.
          //
          // max-h + internal scroll are load-bearing, not polish: the panel is
          // position:fixed, so anything taller than the viewport hangs off the screen
          // with no way to scroll to it — the page behind cannot move it. On a phone that
          // put the footer's Save button off-screen for every dialog whose height depends
          // on data (mic slots, member lists, the type-to-confirm delete), i.e. the work
          // was un-saveable rather than ugly. The sheet uses 88dvh (the SMALL viewport,
          // clear of iOS's toolbars) where the engine knows dvh, and 85vh where it does
          // not — an unknown unit would drop the cap entirely.
          "fixed inset-x-0 bottom-0 z-50 mx-auto grid w-full max-w-lg gap-4",
          "max-h-[85vh] supports-[height:1dvh]:max-h-[88dvh] overflow-y-auto overscroll-contain",
          "rounded-t-[12px] bg-popover text-popover-foreground shadow-elev-2",
          "px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-2",
          "data-[state=open]:animate-sheet-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-full data-[state=closed]:duration-2",
          // sm and up: the centred panel. sm:max-h restates 85vh because the sheet's
          // supports-[] rule would otherwise still apply here.
          "sm:bottom-auto sm:left-[50%] sm:right-auto sm:top-[50%] sm:translate-x-[-50%] sm:translate-y-[-50%]",
          "sm:max-h-[85vh] sm:rounded-[4px] sm:p-6 sm:shadow-edge",
          "sm:data-[state=open]:animate-in sm:data-[state=open]:fade-in-0 sm:data-[state=open]:zoom-in-95 sm:data-[state=open]:duration-2 sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        <RememberOpener into={opener} />
        {/* Decorative: says "this is a sheet". Dragging is not wired; the scrim, Esc and
            the close button dismiss it. */}
        <div
          aria-hidden
          data-sheet-grabber=""
          className="mx-auto -mb-1 mt-1 h-1 w-9 rounded-[2px] bg-foreground/25 sm:hidden"
        />
        {children}
        {/* A 44 px target holding a 32 px well — the visible square stays small. */}
        <DialogPrimitive.Close className="absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-[3px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none sm:right-3 sm:top-3">
          <span className="grid h-8 w-8 place-items-center rounded-[2px] bg-muted">
            <X className="h-4 w-4" aria-hidden />
          </span>
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  // pr-10 keeps a long title clear of the 44 px close button.
  <div
    className={cn("flex flex-col space-y-1.5 pr-10 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      // Phone: two thumb-sized 50 px buttons side by side, cancel left, action right
      // (call sites already put cancel first). An odd last button — a lone action, or
      // the third of three — takes the full row. sm+: the usual right-aligned row.
      "grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 [&>a]:h-[50px] [&>button]:h-[50px]",
      "sm:flex sm:flex-row sm:justify-end sm:[&>a]:h-11 sm:[&>button]:h-11",
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

/**
 * English titles are the display H2 (italic caps, 26 px); a Thai title — most of the
 * confirm copy today — stays upright Kanit at a size its tone marks fit, detected
 * from the text so no caller has to remember.
 */
const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      hasThai(children) ? "text-xl font-semibold leading-snug" : "h2 text-[26px]",
      className
    )}
    {...props}
  >
    {children}
  </DialogPrimitive.Title>
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-[14px] leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
