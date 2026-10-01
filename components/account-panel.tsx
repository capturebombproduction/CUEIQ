"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
// Radix directly, not components/ui/dialog: this sheet is the shell's own surface
// (a bottom sheet below lg, an anchored panel from lg up) and must not move when
// the shared Dialog primitive is restyled.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Contact,
  Disc3,
  Headphones,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Maximize,
  Moon,
  Pipette,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { activeNavHref, bottomTabsFor, MORE_HREF } from "@/components/main-nav";
import { FeedbackButton, useFeedbackUnread } from "@/components/feedback-button";
import { ChangePasswordDialog } from "@/components/change-password-button";
import { KioskMode, useFullscreen } from "@/components/kiosk-mode";
import { useSignOut } from "@/components/sign-out-button";
import { markWhatsNewSeen, useWhatsNewUnseen, whatsNewItems } from "@/components/whats-new";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HEX,
  loadAccentHex,
  resetAccent,
  saveAccent,
} from "@/lib/accent";
import { isDarkMode, setThemeMode } from "@/lib/theme-mode";
import { APP_VERSION } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import type { Perms } from "@/lib/permissions";

// ─── one open/closed state, two openers ─────────────────────────────────────

type PanelState = { open: boolean; setOpen: (open: boolean) => void };
const AccountPanelContext = createContext<PanelState | null>(null);

/**
 * The More tab (below lg) and the header avatar (lg up, and the desktop app) open
 * the SAME panel. One state, so the two can never disagree about whether it is open.
 */
export function AccountPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <AccountPanelContext.Provider value={value}>{children}</AccountPanelContext.Provider>;
}

/** Throws without a provider on purpose: a More tab wired to nothing would render,
 *  look right, and open nothing — the "fix that never runs" this project keeps
 *  finding. A missing provider should fail the first test that mounts it. */
export function useAccountPanel(): PanelState {
  const ctx = useContext(AccountPanelContext);
  if (!ctx) throw new Error("useAccountPanel() needs an <AccountPanelProvider> above it");
  return ctx;
}

/** The dot on More and on the avatar: an answered report waiting to be read, or a
 *  round of "มีอะไรใหม่" this device has not read. Inside the panel each has its own
 *  tile with its own dot, so the dot outside is never a mystery. */
export function useAccountAttention(): boolean {
  const unread = useFeedbackUnread();
  const unseen = useWhatsNewUnseen();
  return unread > 0 || unseen;
}

// ─── destinations ───────────────────────────────────────────────────────────

/** Icon + Thai helper per destination; the tab bar reads the icons too. */
export const DESTINATIONS: Record<string, { icon: LucideIcon; hint: string }> = {
  "/dashboard": { icon: CalendarDays, hint: "งานทั้งหมด" },
  "/overview": { icon: LayoutDashboard, hint: "ภาพรวมงาน · ตารางสัปดาห์" },
  "/library": { icon: Disc3, hint: "คลังเพลง" },
  "/practice": { icon: Headphones, hint: "ห้องซ้อม · โน้ตซ้อม" },
  "/groups": { icon: Users, hint: "สมาชิก · ไมค์ · สีประจำตัว" },
  "/crew": { icon: Contact, hint: "รายชื่อทีมงาน" },
  "/admin": { icon: ShieldCheck, hint: "ผู้ใช้ · สำรองข้อมูล" },
  [MORE_HREF]: { icon: LayoutGrid, hint: "" },
};

const TILE =
  "well relative flex min-h-[94px] w-full flex-col items-start rounded-[2px] p-3 text-left transition-colors duration-2 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

// ─── small pieces ───────────────────────────────────────────────────────────

/** First letter of the name. A Thai name can open with a leading vowel (เ แ โ ใ ไ),
 *  which is written before the consonant it belongs to — "เมย์" → "ม", not "เ". */
function initial(name?: string | null): string {
  const n = name?.trim().replace(/^[เแโใไ]/, "") ?? "";
  return n ? Array.from(n)[0].toUpperCase() : "•";
}

function Avatar({ name, size }: { name?: string | null; size: "sm" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid flex-none place-items-center rounded-[3px] bg-primary font-sans font-bold leading-none text-primary-foreground",
        size === "lg"
          ? "ml-1 h-[46px] w-[46px] text-[19px] shadow-[0_0_0_2px_hsl(var(--popover)),0_0_0_4px_hsl(var(--primary)/.55)]"
          : "h-8 w-8 text-[14px] shadow-[0_0_0_2px_hsl(var(--background)),0_0_0_4px_hsl(var(--primary)/.55)]"
      )}
    >
      {initial(name)}
    </span>
  );
}

/** "v0.1.22" for a desktop build, the commit for a web build ("dev" locally). */
function versionLabel(v: string): string {
  const desktop = /^desktop-(.+)$/.exec(v);
  if (desktop) return `v${desktop[1]}`;
  return /^\d+\.\d+/.test(v) ? `v${v}` : v;
}

/** The header's account button, lg up on the web and always on the desktop. */
export function AccountButton({ name, className }: { name?: string | null; className?: string }) {
  const { open, setOpen } = useAccountPanel();
  const attention = useAccountAttention();
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={open ? "ปิดเมนูบัญชี" : attention ? "เมนูบัญชี · มีรายการใหม่" : "เมนูบัญชี"}
      title={name ?? undefined}
      className={cn(
        "relative grid h-11 w-11 shrink-0 place-items-center rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <Avatar name={name} size="sm" />
      {attention && (
        <i aria-hidden data-testid="avatar-unread-dot" className="dot right-0.5 top-0.5" />
      )}
    </button>
  );
}

function Row({
  icon: Icon,
  title,
  hint,
  right,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  icon: LucideIcon;
  title: string;
  hint: string;
  right?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex h-[54px] w-full items-center gap-3 bg-muted px-3.5 text-left transition-colors duration-2 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      {...props}
    >
      <span className="grid h-8 w-8 flex-none place-items-center rounded-[2px] bg-foreground/[.07] text-muted-foreground">
        <Icon className="h-[17px] w-[17px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium leading-tight">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-tight text-faint">{hint}</span>
      </span>
      {right}
    </button>
  );
}

/** Dark | Light, bound to the real theme. No "Auto": the app is dark by default
 *  because venues are dark, not because the phone says so. Exported for Live tools
 *  (live-mode.tsx): Live Mode cannot open this panel (no header, and its leave guard
 *  must not sit beside the panel's links and sign-out), so the switch goes there too. */
export function ThemeSeg() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(isDarkMode()), []);
  const choose = (d: boolean) => {
    setDark(d);
    setThemeMode(d);
  };
  return (
    <div className="seg en" role="radiogroup" aria-label="ธีม">
      <button
        type="button"
        role="radio"
        aria-checked={dark}
        onClick={() => choose(true)}
        className={cn("transition-colors duration-2", dark && "on")}
      >
        <Moon className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        Dark
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!dark}
        onClick={() => choose(false)}
        className={cn("transition-colors duration-2", !dark && "on")}
      >
        <Sun className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        Light
      </button>
    </div>
  );
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const SELECTED_RING = "shadow-[0_0_0_2px_hsl(var(--popover)),0_0_0_4px_hsl(var(--foreground))]";

/** สีวง: the presets as swatches, a custom colour, and the reset — what the old
 *  AccentPicker dialog held, laid flat. Each swatch is a 44 px target around a 30 px
 *  chip, and the swatches WRAP. A sideways-scrolling row showed 6 of its 11 options
 *  on a phone and in the 380 px panel alike — Emerald, Sky, Royal, Sakura and the
 *  custom picker sat off the edge, the seventh cut to a sliver that read as a
 *  divider, and nothing said the row scrolled. Two rows of 44 px show every one. */
function BandColourRow() {
  const [hex, setHex] = useState<string>(DEFAULT_ACCENT_HEX);
  useEffect(() => setHex(loadAccentHex() ?? DEFAULT_ACCENT_HEX), []);
  const choose = (next: string) => {
    setHex(next);
    saveAccent(next);
  };
  const custom = !ACCENT_PRESETS.some((p) => sameHex(p.hex, hex));
  return (
    <div className="mt-2 flex items-start">
      {/* h-11: the label and the reset line up with the FIRST row of swatches */}
      <span className="ml-1.5 mr-1 flex h-11 flex-none items-center text-[13px] text-muted-foreground">
        สีวง
      </span>
      <div
        role="radiogroup"
        aria-label="สีประจำวง"
        className="flex min-w-0 flex-1 flex-wrap items-center"
      >
        {ACCENT_PRESETS.map((p) => {
          const on = sameHex(p.hex, hex);
          return (
            <button
              key={p.hex}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={p.name}
              title={p.name}
              onClick={() => choose(p.hex)}
              className="grid h-11 w-11 flex-none place-items-center rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span
                className={cn("block h-[30px] w-[30px] rounded-[2px]", on && SELECTED_RING)}
                style={{ backgroundColor: p.hex }}
              />
            </button>
          );
        })}
        <label
          title="เลือกสีเอง"
          className="relative grid h-11 w-11 flex-none cursor-pointer place-items-center rounded-[3px] focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring"
        >
          <span
            className={cn(
              "grid h-[30px] w-[30px] place-items-center rounded-[2px] text-muted-foreground",
              custom ? SELECTED_RING : "bg-foreground/[.07]"
            )}
            style={custom ? { backgroundColor: hex } : undefined}
          >
            {!custom && <Pipette className="h-4 w-4" aria-hidden />}
          </span>
          <input
            type="color"
            value={hex}
            onChange={(e) => choose(e.target.value)}
            aria-label="เลือกสีแบบกำหนดเอง"
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => {
          setHex(DEFAULT_ACCENT_HEX);
          resetAccent();
        }}
        aria-label="ค่าเริ่มต้น"
        title="กลับเป็นสีเริ่มต้น"
        className="grid h-11 w-11 flex-none place-items-center rounded-[3px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RotateCcw className="h-[18px] w-[18px]" aria-hidden />
      </button>
    </div>
  );
}

function FullscreenSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative h-7 w-[46px] flex-none rounded-[2px] transition-colors duration-2",
        on ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "absolute left-[3px] top-[3px] h-[22px] w-[22px] rounded-[1px] bg-white transition-transform duration-2 ease-out",
          on && "translate-x-[18px]"
        )}
      />
    </span>
  );
}

function CloseButton() {
  return (
    <DialogPrimitive.Close
      aria-label="ปิดเมนู"
      className="grid h-11 w-11 flex-none place-items-center rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="well grid h-8 w-8 place-items-center rounded-[2px] text-muted-foreground">
        <X className="h-4 w-4" strokeWidth={2.4} aria-hidden />
      </span>
    </DialogPrimitive.Close>
  );
}

// ─── the panel ──────────────────────────────────────────────────────────────

/**
 * The More sheet / account panel (FINAL-SPEC-v2 §F.3). Everything that used to sit
 * in the header besides the bell and install — theme, band colour, fullscreen,
 * password, sign-out — plus the destinations that did not earn a tab, What's New,
 * and Feedback (the floating แจ้งปัญหา button is gone; this tile replaced it).
 *
 * Mounted ONCE per shell. A bottom sheet below lg; from lg up a panel anchored
 * under the header's avatar. Its contents exist only while it is open, so the parts
 * that must outlive that — the password dialog it hands off to and the installed-
 * app fullscreen nudge — are mounted beside the dialog, not inside it.
 *
 * `destinations`: "below-lg" (web — from lg up the header's inline nav already
 * lists them) or "never" (desktop — its nav is inline at every width).
 */
export function AccountPanel({
  name,
  line,
  perms,
  userId,
  tenantId,
  canEdit,
  destinations = "below-lg",
}: {
  name?: string | null;
  /** "role · band", e.g. "สมาชิก · Seishin Kakumei" (lib/role-label.ts). */
  line?: string | null;
  perms?: Perms;
  userId?: string | null;
  tenantId?: string | null;
  /** Can edit some band's shows — What's New leaves editor-only items out otherwise. */
  canEdit: boolean;
  destinations?: "below-lg" | "never";
}) {
  const { open, setOpen } = useAccountPanel();
  const pathname = usePathname() ?? "";
  const [view, setView] = useState<"home" | "news">("home");
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Set while handing focus to the password dialog, so closing this panel does not
  // pull focus back to the More tab underneath it.
  const handingOff = useRef(false);

  // A destination tap navigates; the sheet must not ride along onto the next page.
  useEffect(() => setOpen(false), [pathname, setOpen]);
  useEffect(() => {
    if (!open) setView("home");
  }, [open]);

  const layout = useMemo(() => bottomTabsFor(perms), [perms]);
  const links = layout.more.filter((l) => l.href !== "/feedback"); // Feedback is the tile
  // The page you are on, when it is one of the sheet's destinations (an admin on
  // /admin): its tile carries the band rail, as the lit tab would.
  const activeDest = activeNavHref(
    pathname,
    [...layout.tabs, ...layout.more].map((l) => l.href).filter((h) => h !== MORE_HREF)
  );

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[hsl(var(--scrim)/var(--scrim-a))] data-[state=open]:animate-in data-[state=open]:fade-in-0 lg:bg-transparent" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            data-testid="account-panel"
            onCloseAutoFocus={(e) => {
              if (handingOff.current) {
                e.preventDefault();
                handingOff.current = false;
              }
            }}
            className={cn(
              "no-print fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto overscroll-contain rounded-t-[12px] bg-popover pb-[calc(env(safe-area-inset-bottom)+16px)] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-popover-foreground shadow-elev-2 focus:outline-none data-[state=open]:animate-sheet-in",
              "lg:inset-x-auto lg:bottom-auto lg:left-auto lg:right-4 lg:top-[64px] lg:max-h-[80vh] lg:w-[380px] lg:rounded-[4px] lg:pb-4 lg:shadow-float lg:data-[state=open]:animate-in lg:data-[state=open]:fade-in-0 lg:data-[state=open]:zoom-in-95"
            )}
          >
            <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-[2px] bg-foreground/25 lg:hidden" />
            <DialogPrimitive.Title className="sr-only">More</DialogPrimitive.Title>
            {view === "news" ? (
              <NewsView canEdit={canEdit} onBack={() => setView("home")} />
            ) : (
              <div className="pt-3">
                <div className="flex items-center gap-3.5">
                  <Avatar name={name} size="lg" />
                  <div className="min-w-0 flex-1">
                    {/* py + -my: room inside the clip for Kanit's tone marks and ุ,
                        which leading-none's line box cuts ("พี่บุ๊ค"); same height */}
                    <div className="disp truncate py-[.25em] -my-[.25em] text-[22px] leading-none">{name ?? "—"}</div>
                    {line && (
                      <div className="mt-1 truncate text-[12.5px] text-muted-foreground">{line}</div>
                    )}
                  </div>
                  <CloseButton />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-[3px]">
                  {destinations === "below-lg" &&
                    links.map((l) => {
                      const meta = DESTINATIONS[l.href];
                      const Icon = meta?.icon ?? LayoutGrid;
                      const here = l.href === activeDest;
                      return (
                        <Link
                          key={l.href}
                          href={l.href}
                          onClick={() => setOpen(false)}
                          aria-current={here ? "page" : undefined}
                          className={cn(
                            TILE,
                            "lg:hidden",
                            here && "shadow-[inset_3px_0_0_hsl(var(--primary))]"
                          )}
                        >
                          <Icon className="h-[22px] w-[22px] text-primary-ink" aria-hidden />
                          <span className="caps mt-2 text-[19px] leading-none tracking-[.03em]">
                            {l.label}
                          </span>
                          {meta?.hint && (
                            <span className="mt-1 text-[11.5px] leading-snug text-faint">{meta.hint}</span>
                          )}
                        </Link>
                      );
                    })}
                  <WhatsNewTile onOpen={() => setView("news")} />
                  <FeedbackButton userId={userId} tenantId={tenantId} />
                </div>

                <div className="eyebrow mb-2 mt-4 px-0.5 text-faint">Appearance</div>
                <ThemeSeg />
                <BandColourRow />

                <AccountRows
                  onChangePassword={() => {
                    handingOff.current = true;
                    setOpen(false);
                    setPasswordOpen(true);
                  }}
                />

                <p className="mt-3 text-center text-[11px] text-faint">
                  CueIQ <span className="num text-[12.5px]">{versionLabel(APP_VERSION)}</span> ·
                  Designed by PatzNutthapat
                </p>
              </div>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <KioskMode button={false} />
    </>
  );
}

function AccountRows({ onChangePassword }: { onChangePassword: () => void }) {
  const fullscreen = useFullscreen();
  const signOut = useSignOut();
  return (
    <div className="stack mt-3 overflow-hidden rounded-[2px]">
      {fullscreen.available && (
        <Row
          icon={Maximize}
          title="Fullscreen"
          hint="เต็มจอสำหรับวันโชว์"
          role="switch"
          aria-checked={fullscreen.fs}
          onClick={fullscreen.toggle}
          right={<FullscreenSwitch on={fullscreen.fs} />}
        />
      )}
      <Row
        icon={KeyRound}
        title="Change password"
        hint="เปลี่ยนรหัสผ่านของคุณ"
        onClick={onChangePassword}
        right={<ChevronRight className="h-[17px] w-[17px] text-faint" strokeWidth={2.2} aria-hidden />}
      />
      {/* Neutral, never red: leaving is ordinary, and a red row reads as "danger". */}
      <Row
        icon={LogOut}
        title="Sign out"
        hint="ออกจากระบบเครื่องนี้"
        aria-label="ออกจากระบบ"
        onClick={() => void signOut()}
      />
    </div>
  );
}

function WhatsNewTile({ onOpen }: { onOpen: () => void }) {
  const unseen = useWhatsNewUnseen();
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(TILE, unseen && "shadow-[inset_3px_0_0_hsl(var(--notify))]")}
    >
      <Sparkles className="h-[22px] w-[22px] text-primary-ink" aria-hidden />
      {unseen && (
        <i
          aria-hidden
          data-testid="whats-new-unseen-dot"
          className="dot right-3 top-3 h-2.5 w-2.5 shadow-[0_0_0_2px_hsl(var(--muted))]"
        />
      )}
      <span className="caps mt-2 text-[19px] leading-none tracking-[.03em]">What&apos;s New</span>
      <span
        className={cn(
          "mt-1 text-[11.5px] leading-snug",
          unseen ? "font-semibold text-foreground" : "text-faint"
        )}
      >
        {unseen ? "มีอะไรใหม่ · ยังไม่ได้อ่าน" : "มีอะไรใหม่ในรอบนี้"}
      </span>
    </button>
  );
}

/** The same list as the dashboard's "มีอะไรใหม่" card. Opening it IS reading it, so
 *  the round is marked read here — and the card and the dot go with it. */
function NewsView({ canEdit, onBack }: { canEdit: boolean; onBack: () => void }) {
  const [items] = useState(() => whatsNewItems(canEdit));
  useEffect(() => markWhatsNewSeen(), []);
  return (
    <div className="pt-3">
      <div className="flex items-center">
        <button
          type="button"
          onClick={onBack}
          className="caps -ml-2 flex h-11 items-center gap-0.5 rounded-[3px] pr-2 text-[17px] text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2.6} aria-hidden />
          More
        </button>
        <span className="ml-auto" />
        <CloseButton />
      </div>
      <h2 className="h2 mt-1">What&apos;s New</h2>
      <ul data-testid="whats-new-list" className="mt-3 list-disc space-y-1.5 pl-5 text-[14px] text-muted-foreground">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onBack}
        className="mt-4 h-11 w-full rounded-[3px] bg-muted text-[15px] font-semibold shadow-edge transition-colors duration-2 hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        เข้าใจแล้ว
      </button>
    </div>
  );
}
