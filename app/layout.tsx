import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Kanit } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { SwRegister } from "@/components/sw-register";
import { OfflineBanner } from "@/components/offline-banner";
import { OutboxFlusher } from "@/components/outbox-flusher";
import { SkinRefresher } from "@/components/skin-refresher";
import { THEME_COLOR, THEME_STORAGE_KEY } from "@/lib/theme-mode";

// Kanit — the brand Thai font (covers Latin too); self-hosted via next/font.
const kanit = Kanit({
  subsets: ["latin", "thai"],
  // only the weights actually used (font-medium/semibold/bold) — Thai glyph sets are
  // heavy, so don't ship weights nothing references.
  weight: ["400", "500", "600", "700"],
  variable: "--font-kanit",
  display: "swap",
});

// Barlow Condensed — numerals (countdowns, clocks) + English display. No Thai glyphs:
// Thai inside a display element falls through to Kanit (theme.css font stacks).
// TWO loaders, because next/font ships every weight × style pair one loader asks for:
// style ["normal","italic"] here would also ship a 700 italic nothing uses. Three
// Latin faces in all; the desktop bundles the same three from @fontsource.
const barlow = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["700", "800"],
  style: ["normal"],
  variable: "--font-barlow",
  display: "swap",
});
// The italic is its own family (and variable), read only by --font-display-x.
const barlowX = Barlow_Condensed({
  subsets: ["latin"],
  weight: "800",
  style: "italic",
  variable: "--font-barlow-x",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "CueIQ — Smart cues for every show.",
    template: "%s · CueIQ",
  },
  description:
    "CueIQ — Show & Event Management Platform. Run sheets, setlists, mic maps and live countdowns for idol & artist shows.",
  applicationName: "CueIQ",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CueIQ",
  },
  icons: {
    apple: "/apple-touch-icon.png",
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // cover: the page runs under the notch and the home indicator, and the header,
  // tab bar and sheets pad themselves with env(safe-area-inset-*) — without it
  // those insets read 0 and the glass bars stop short of the screen edges.
  viewportFit: "cover",
  // The dark page colour (dark is the default). A light-mode device is switched
  // to THEME_COLOR.light before first paint by the script below, and by the
  // theme switch afterwards (lib/theme-mode.ts).
  themeColor: THEME_COLOR.dark,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="th"
      className={`dark ${kanit.variable} ${barlow.variable} ${barlowX.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans antialiased">
        {/* Pre-paint, no-flash setup: (1) default dark — only flip to light if the
            user chose it, status-bar colour included; (2) apply the saved band
            accent color if any. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('${THEME_STORAGE_KEY}')==='light'){document.documentElement.classList.remove('dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content','${THEME_COLOR.light}')}}catch(e){}try{var a=JSON.parse(localStorage.getItem('cueiq:accent')||'null');if(a&&a.css){var st=document.createElement('style');st.id='cueiq-skin';st.textContent=a.css;document.head.appendChild(st);}}catch(e){}`,
          }}
        />
        <OfflineBanner />
        <OutboxFlusher />
        {/* Re-derives a saved band colour on every page (AccentPicker used to). */}
        <SkinRefresher />
        {children}
        {/* Bare on purpose: placement (under the header) and the no-richColors
            rule belong to the primitive, components/ui/sonner.tsx (spec §E.10). */}
        <Toaster />
        <SwRegister />
      </body>
    </html>
  );
}
