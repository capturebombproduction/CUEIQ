"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { activeTabHref, bottomTabsFor, MORE_HREF } from "@/components/main-nav";
import { DESTINATIONS, useAccountAttention, useAccountPanel } from "@/components/account-panel";
import { isImmersivePath } from "@/components/chrome-gate";
import { cn } from "@/lib/utils";
import type { Perms } from "@/lib/permissions";

/** Input types that never raise a soft keyboard. */
const NO_KEYBOARD = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function raisesKeyboard(el: EventTarget | null): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && !NO_KEYBOARD.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable === true;
}

/**
 * True while a touch device is typing into something. A fixed bottom bar rides up
 * on top of the iOS keyboard (and Android shrinks the viewport under it), which
 * covers the field being typed into and offers four tabs nobody wants mid-sentence.
 * Read from focus rather than viewport sizes: focus is the same signal on every
 * engine, while viewport resizing differs between iOS and Android. A mouse-and-
 * keyboard browser is left alone — its keyboard never covers the screen.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.("(pointer: coarse)").matches !== true) return;
    const onIn = (e: FocusEvent) => setOpen(raisesKeyboard(e.target));
    const onOut = (e: FocusEvent) => setOpen(raisesKeyboard(e.relatedTarget));
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    setOpen(raisesKeyboard(document.activeElement));
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return open;
}

/**
 * The phone's bottom tab bar (FINAL-SPEC-v2 §F.2): below lg, three destinations
 * picked for this role by bottomTabsFor() plus More, which opens the account panel.
 * From lg up the header's inline nav takes over and this is hidden by CSS.
 *
 * `--tabbar-h` is the space the bar takes at the bottom, and everything that floats
 * above it (PushNudge, the Library mini-player, the page's bottom padding) reads it.
 * The token says 58px; this component zeroes it on the immersive Live screens, where
 * the bar is not drawn, so nothing there keeps a 58px gap for a bar that is not
 * there. (lg and up: the (app) layout zeroes it with `lg:[--tabbar-h:0px]`; the
 * desktop app, which has no bar, zeroes it in its shell.)
 */
export function TabBar({ perms }: { perms?: Perms }) {
  const pathname = usePathname() ?? "";
  const layout = useMemo(() => bottomTabsFor(perms), [perms]);
  const active = activeTabHref(pathname, layout);
  const { open, setOpen } = useAccountPanel();
  const attention = useAccountAttention();
  const keyboard = useKeyboardOpen();
  const immersive = isImmersivePath(pathname);

  useEffect(() => {
    const style = document.documentElement.style;
    if (immersive) style.setProperty("--tabbar-h", "0px");
    else style.removeProperty("--tabbar-h");
    return () => {
      style.removeProperty("--tabbar-h");
    };
  }, [immersive]);

  if (immersive) return null;
  return (
    <nav
      aria-label="แถบเมนูล่าง"
      data-testid="tab-bar"
      className={cn(
        "no-print glass glass-bottom fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)] transition-transform duration-2 ease-out lg:hidden",
        keyboard && "translate-y-full"
      )}
    >
      <div className="grid h-[var(--tabbar-h)] grid-cols-4">
        {layout.tabs.map((t) => {
          const Icon = DESTINATIONS[t.href]?.icon ?? LayoutGrid;
          const current = active === t.href;
          const lit = current || (t.href === MORE_HREF && open);
          const icon = (
            <span className="ico">
              <Icon className="h-[23px] w-[23px]" strokeWidth={lit ? 2.3 : 1.8} aria-hidden />
              {t.href === MORE_HREF && attention && (
                <i aria-hidden data-testid="more-unread-dot" className="dot -right-1.5 top-0" />
              )}
            </span>
          );
          if (t.href === MORE_HREF) {
            return (
              <button
                key={t.href}
                type="button"
                onClick={() => setOpen(!open)}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={open ? "ปิดเมนู" : "เมนูเพิ่มเติม"}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "tab transition-colors duration-2",
                  // Open but not "here": look lit without claiming aria-current.
                  open &&
                    !current &&
                    "text-foreground before:absolute before:inset-x-[20%] before:top-0 before:h-[3px] before:bg-primary before:content-[''] [&_.ico]:text-primary-ink"
                )}
              >
                {icon}
                <span className="lbl">{t.label}</span>
              </button>
            );
          }
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={current ? "page" : undefined}
              className="tab transition-colors duration-2"
            >
              {icon}
              <span className="lbl">{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
