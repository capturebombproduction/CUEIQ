import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

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
    <html lang="th" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {/* Pre-paint, no-flash setup: (1) default dark — only flip to light if the
            user chose it; (2) apply the saved band accent color if any. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('cueiq:theme')==='light')document.documentElement.classList.remove('dark')}catch(e){}try{var a=JSON.parse(localStorage.getItem('cueiq:accent')||'null');if(a&&a.primary){var s=document.documentElement.style;s.setProperty('--primary',a.primary);s.setProperty('--ring',a.primary);s.setProperty('--primary-foreground',a.fg);}}catch(e){}`,
          }}
        />
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
