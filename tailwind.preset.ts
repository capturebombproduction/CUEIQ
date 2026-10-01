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
      screens: {
        stage: { raw: "(orientation: landscape) and (min-width: 900px) and (min-height: 700px)" },
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
        // TEMPORARY — the spec deletes pulse-ring (it dims the whole overtime card,
        // controls included, to 45 %), but Live Mode and the desktop Quick Show still
        // mark OVER with `animate-pulse-ring` until the Live slice moves both to
        // `.alarm-plate`. Dropped early, the class compiled to nothing and OVER became
        // the same static card as URGENT, told apart only by the "-" on the clock.
        // Delete this and the animation below in the same commit as those two screens.
        // (lib/theme-single-source.test.ts fails any animate-* class that ships empty.)
        "pulse-ring": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      // sheet-in / onair keyframes live in app/stage.css (its classes name them too).
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-ring": "pulse-ring 1.4s ease-in-out infinite",
        "sheet-in": "sheet-in var(--dur-3) var(--ease-out)",
        onair: "onair 1.2s steps(1) infinite",
      },
    },
  },
  plugins: [animate],
};
export default preset;
