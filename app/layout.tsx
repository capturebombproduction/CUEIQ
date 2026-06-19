import type { Metadata, Viewport } from "next";
import { Kanit } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// Kanit — the brand Thai font (covers Latin too); self-hosted via next/font.
const kanit = Kanit({
  subsets: ["latin", "thai"],
  // only the weights actually used (font-medium/semibold/bold) — Thai glyph sets are
  // heavy, so don't ship weights nothing references.
  weight: ["400", "500", "600", "700"],
  variable: "--font-kanit",
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
  themeColor: "#4f46e5",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" className={`dark ${kanit.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {/* Pre-paint, no-flash setup: (1) default dark — only flip to light if the
            user chose it; (2) apply the saved band accent color if any. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('cueiq:theme')==='light')document.documentElement.classList.remove('dark')}catch(e){}try{var a=JSON.parse(localStorage.getItem('cueiq:accent')||'null');if(a&&a.css){var st=document.createElement('style');st.id='cueiq-skin';st.textContent=a.css;document.head.appendChild(st);}}catch(e){}`,
          }}
        />
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
