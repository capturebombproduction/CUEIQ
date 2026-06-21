"use client";

import { useEffect, useRef, useState } from "react";
import { Coffee, Pause, Play, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function mmss(sec: number) {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Break timer for practice (โหมดซ้อม) — pick 5 / 10 min or a custom length, counts
 * down, beeps + toasts when done. Pure client; nothing is saved.
 */
export function BreakTimer() {
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(0); // seconds set for this run
  const [remaining, setRemaining] = useState(0);
  const [running, setRunning] = useState(false);
  const [custom, setCustom] = useState("15");
  const deadlineRef = useRef<number | null>(null); // absolute end time while running
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Create/resume the AudioContext from WITHIN a user gesture (start/resume tap) so
  // iOS lets the end-of-break beep — fired later from the timer — actually sound.
  function unlockAudio() {
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        audioCtxRef.current = new Ctx();
      }
      if (audioCtxRef.current.state === "suspended")
        void audioCtxRef.current.resume().catch(() => {});
    } catch {
      /* ignore — toast still fires when the timer ends */
    }
  }

  // short, gentle beep when the break ends — reuses the gesture-unlocked context
  function beep() {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      o.start();
      o.stop(ctx.currentTime + 0.65);
    } catch {
      /* ignore — toast still fires */
    }
  }

  // close the shared context on unmount
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  // tick from an absolute deadline so a backgrounded tab still ends on time
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (deadlineRef.current == null) return;
      const left = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        setRunning(false);
        deadlineRef.current = null;
        beep();
        toast.success("หมดเวลาพักแล้ว — กลับมาซ้อมต่อ! ☕");
      }
    }, 250);
    return () => clearInterval(id);
  }, [running]);

  function startWith(seconds: number) {
    if (seconds <= 0) return;
    unlockAudio(); // within this tap, so the end beep can sound on iOS
    setTotal(seconds);
    setRemaining(seconds);
    deadlineRef.current = Date.now() + seconds * 1000;
    setRunning(true);
  }

  function toggle() {
    if (running) {
      setRunning(false);
      deadlineRef.current = null;
    } else if (remaining > 0) {
      unlockAudio(); // resume tap — keep the context warm for the beep
      deadlineRef.current = Date.now() + remaining * 1000;
      setRunning(true);
    }
  }

  function reset() {
    setRunning(false);
    deadlineRef.current = null;
    setRemaining(total);
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Coffee className="h-4 w-4" /> เวลาพัก
      </Button>
    );
  }

  const active = remaining > 0 || running;
  const danger = active && remaining <= 10;

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Coffee className="h-4 w-4" /> เวลาพัก
        </span>
        <button
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {active ? (
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "tabular-nums text-3xl font-bold",
              danger ? "text-destructive" : "text-foreground"
            )}
          >
            {mmss(remaining)}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="icon" onClick={toggle}>
              {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" onClick={reset} title="รีเซ็ต">
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => startWith(5 * 60)}>
            5 นาที
          </Button>
          <Button variant="secondary" size="sm" onClick={() => startWith(10 * 60)}>
            10 นาที
          </Button>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              max={180}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="h-9 w-16"
            />
            <span className="text-xs text-muted-foreground">นาที</span>
            <Button
              size="sm"
              onClick={() => startWith(Math.round(Number(custom) || 0) * 60)}
            >
              เริ่ม
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
