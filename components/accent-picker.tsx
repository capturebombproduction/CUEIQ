"use client";

import { useEffect, useState } from "react";
import { Palette, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HEX,
  loadAccentHex,
  resetAccent,
  saveAccent,
} from "@/lib/accent";

/**
 * Band "DNA color" / skin picker. Recolors the app's primary accent (CTAs, badges,
 * rings) with a preset or a fully custom color — a taste of the future per-band
 * customizable skins. Saved per-device for now.
 */
export function AccentPicker() {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState<string>(DEFAULT_ACCENT_HEX);

  useEffect(() => {
    setHex(loadAccentHex() ?? DEFAULT_ACCENT_HEX);
  }, []);

  function choose(next: string) {
    setHex(next);
    saveAccent(next);
  }

  function reset() {
    setHex(DEFAULT_ACCENT_HEX);
    resetAccent();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="สีประจำวง (สกิน)"
          aria-label="เลือกสีประจำวง"
        >
          <Palette className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>สีประจำวง (DNA / สกิน)</DialogTitle>
          <DialogDescription>
            เลือกสีหลักของแอปให้เข้ากับเอกลักษณ์ของวง — มีผลกับปุ่ม แบดจ์ และไฮไลต์ต่าง ๆ
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* presets */}
          <div className="grid grid-cols-5 gap-2">
            {ACCENT_PRESETS.map((p) => {
              const active = hex.toLowerCase() === p.hex.toLowerCase();
              return (
                <button
                  key={p.hex}
                  type="button"
                  onClick={() => choose(p.hex)}
                  title={p.name}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-lg ring-offset-2 ring-offset-background transition-transform hover:scale-105",
                    active && "ring-2 ring-foreground"
                  )}
                  style={{ backgroundColor: p.hex }}
                >
                  {active && (
                    <Check className="h-4 w-4 text-white drop-shadow" />
                  )}
                </button>
              );
            })}
          </div>

          {/* custom color */}
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">เลือกสีเอง</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {hex.toUpperCase()}
              </p>
            </div>
            <label className="relative cursor-pointer">
              <span
                className="block h-10 w-16 rounded-md border shadow-sm"
                style={{ backgroundColor: hex }}
              />
              <input
                type="color"
                value={hex}
                onChange={(e) => choose(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="เลือกสีแบบกำหนดเอง"
              />
            </label>
          </div>

          <div className="flex justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={reset}>
              <RotateCcw className="h-4 w-4" /> ค่าเริ่มต้น
            </Button>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              เสร็จสิ้น
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
