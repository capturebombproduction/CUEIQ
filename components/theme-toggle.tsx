"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Light/dark toggle. The app defaults to dark (venues are dark); the layout's inline
 * script sets the initial `.dark` class before paint, and this just flips it and
 * remembers the choice in localStorage (cueiq:theme).
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  // sync the icon with the real class after mount (a light-preferring user had the
  // class removed by the pre-paint script)
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("cueiq:theme", next ? "dark" : "light");
    } catch {}
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      title={dark ? "สลับเป็นโหมดสว่าง" : "สลับเป็นโหมดมืด"}
      aria-label="สลับธีมสว่าง/มืด"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
