"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

/**
 * "Install app" button — appears only when the browser offers PWA installation
 * (Chrome/Edge/Android fire `beforeinstallprompt`). Installing gives a home-screen
 * launcher + the offline service worker. Hidden when already installed, and on
 * browsers that don't support the prompt (e.g. iOS Safari uses Share → Add to Home).
 */
export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return; // already installed
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => setPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!prompt) return null;

  async function install() {
    const p = prompt;
    setPrompt(null);
    try {
      await p?.prompt();
    } catch {
      /* user dismissed */
    }
  }

  return (
    <button
      type="button"
      onClick={install}
      title="ติดตั้ง CueIQ ลงเครื่อง — เปิดเร็วขึ้นและใช้ออฟไลน์ได้"
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      <Download className="h-4 w-4" />
      <span className="hidden sm:inline">ติดตั้งแอป</span>
    </button>
  );
}
