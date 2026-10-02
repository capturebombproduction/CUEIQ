import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// The ONE Tailwind theme, shared by the web app (tailwind.config.ts) and the desktop
// renderer (desktop/tailwind.config.ts). The desktop config used to hand-mirror this
// block; a value changed in one and not the other would only show up as "the .exe
// looks slightly off". Each config now keeps just what really differs — its content
// globs — plus darkMode, and loads this.
//
// Colours here are NAMES, not values: every one reads an hsl(var(--token)) whose
// value lives in app/theme.css. Retheming happens there, not here. This is also where
// aliases live (theme.css tokens are leaves — see its header): `surface-1` is --card.
//
// `<alpha-value>` so an opacity modifier (bg-warning/10, text-foreground/90) works
// on every token, the way the redesign's chips and washes use them.
//
// Component classes (.chip, .seg, .cut …) and the keyframes the animations below
// name are NOT here: they are plain CSS in app/stage.css, imported by both apps
// (its header explains why not addComponents / @layer components).
//
// The plugin is imported from THIS file, so both builds resolve it from the repo
// root's node_modules (desktop CI runs the root `npm ci` before desktop's).
const c = (v: string) => `hsl(var(--${v}) / <alpha-value>)`;
const tone = (n: string, ink = false) => ({
  DEFAULT: c(n),
  foreground: c(`${n}-foreground`),
  ...(ink ? { ink: c(`${n}-ink`) } : {}),
});

const preset: Partial<Config> = {
  theme: {
    container: {
      center: true,
      // A flat 1rem. The spec's { DEFAULT, sm: "1.5rem", lg: "2rem" } compiles to this
      // same 1rem: Tailwind's container plugin only pads at breakpoints listed in
      // container.screens, and listing sm / lg there would also cap the width at 640 /
      // 1024px. Wider gutters, if wanted, go on the element (`sm:px-6 lg:px-8`).
      padding: "1rem",
      screens: { "2xl": "1280px" },
    },
    extend: {
      // `stage:` — the Live "stage" layout: a landscape iPad / laptop, not merely a
      // wide window. A SCREEN (not an addVariant plugin) so `stage:x` is emitted after
      // `lg:y` and wins on the iPad, which matches both; a plugin variant is emitted
      // BEFORE the screens and would lose. The price: an object-valued screen makes
      // Tailwind drop every `min-*` / `max-*` variant (one build warning, easy to miss),
      // so lib/theme-single-source.test.ts fails any source that writes one.
      //
      // 600 px tall and up, 900 px wide and up, landscape: the stage on any device. A maximised
      // 768p laptop's Chrome or the .exe on a 768 px screen leaves ~620-700 px (CQ-20), and so
      // does an iPad mini's Safari tab in landscape - the stage fits in 600 (the NOW card's
      // countdown box simply gets what is left). Below 600 a touch screen in landscape is a
      // phone: that layout's own query is `max-height: 599.98px` + `pointer: coarse` (Live, the
      // NOW card, the Caller, stage.css) and must stay BELOW this one - an arbitrary @media
      // variant is emitted after this screen, so a device in both would get the phone's
      // `display: contents` on top of the stage's grid (app/stage-css.test.tsx checks the seam).
      screens: {
        stage: {
          raw: "(orientation: landscape) and (min-width: 900px) and (min-height: 600px)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        num: ["var(--font-num)"],
        display: ["var(--font-display)"],
        "display-x": ["var(--font-display-x)"],
        // UNCHANGED on purpose: existing call sites use font-mono for codes / ids.
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderColor: { DEFAULT: c("border") },
      colors: {
        border: c("border"),
        input: c("input"),
        ring: c("ring"),
        background: c("background"),
        foreground: c("foreground"),
        primary: { DEFAULT: c("primary"), foreground: c("primary-foreground"), ink: c("primary-ink") },
        secondary: tone("secondary"),
        destructive: tone("destructive"),
        muted: tone("muted"),
        accent: tone("accent"),
        popover: tone("popover"),
        card: tone("card"),
        warning: tone("warning", true),
        success: tone("success", true),
        info: tone("info", true),
        // Band-independent by rule: overtime plate + unread dot never take a skin.
        alarm: tone("alarm"),
        notify: tone("notify"),
        faint: c("faint-foreground"),
        surface: { 0: c("background"), 1: c("card"), 2: c("muted"), 3: c("popover") },
      },
      // Explicit px, not calc(var(--radius) - 4px): at --radius 4px that collapses to 0.
      borderRadius: { sm: "2px", md: "3px", lg: "4px", xl: "6px", "2xl": "8px", "3xl": "12px" },
      boxShadow: {
        edge: "inset 0 0 0 1px hsl(var(--border))",
        "elev-2":
          "inset 0 1px 0 hsl(var(--foreground) / .1), 0 -24px 60px -20px hsl(var(--shadow) / var(--shadow-a))",
        float:
          "inset 0 0 0 1px hsl(var(--border)), 0 18px 40px -16px hsl(var(--shadow) / var(--shadow-a))",
      },
      backgroundImage: {
        hatch: "repeating-linear-gradient(-45deg, hsl(var(--alarm-foreground)) 0 3px, hsl(var(--alarm)) 3px 6px)",
        hazard: "repeating-linear-gradient(-45deg, hsl(var(--alarm-foreground)) 0 10px, hsl(var(--alarm)) 10px 20px)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out-cue": "var(--ease-in-out)",
        snap: "var(--ease-snap)",
      },
      transitionDuration: { 1: "var(--dur-1)", 2: "var(--dur-2)", 3: "var(--dur-3)" },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        // (pulse-ring is gone: it dimmed the whole overtime card, controls included,
        // to 45 %. Live Mode and Quick Show mark OVER with `.alarm-plate` now.)
      },
      // sheet-in / onair keyframes live in app/stage.css (its classes name them too).
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "sheet-in": "sheet-in var(--dur-3) var(--ease-out)",
        onair: "onair 1.2s steps(1) infinite",
      },
    },
  },
  plugins: [animate],
};
export default preset;
