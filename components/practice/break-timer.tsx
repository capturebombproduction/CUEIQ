"use client";

import { useEffect, useRef, useState } from "react";
import { Coffee, Pause, Play, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Countdown } from "@/components/live/countdown";

const RING_R = 60;
const RING_C = 2 * Math.PI * RING_R;

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
        toast.success("หมดเวลาพักแล้ว — กลับมาซ้อมต่อ!");
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

  // restart the SAME break from the top
  function reset() {
    setRunning(false);
    deadlineRef.current = null;
    setRemaining(total);
  }

  // go back to the duration picker so a new length can be chosen (the old code had
  // no way out once a time was set — reset() kept remaining>0, so it felt "locked")
  function changeTime() {
    setRunning(false);
    deadlineRef.current = null;
    setTotal(0);
    setRemaining(0);
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Coffee className="h-4 w-4" /> เวลาพัก
      </Button>
    );
  }

  const active = remaining > 0 || running;
  const danger = active && remaining <= 10;
  // the ring: what is left of this break, drawn as an arc (no animation — it
  // steps with the clock, which ticks on its own)
  const frac = total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;

  return (
    <section aria-label="Break" className="slab w-full p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow key">Break</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="ปิดเวลาพัก"
          className="-my-1.5 -mr-1.5 text-muted-foreground"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {active ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative grid h-[132px] w-[132px] shrink-0 place-items-center">
            <svg
              viewBox="0 0 132 132"
              aria-hidden
              className="absolute inset-0 h-full w-full -rotate-90"
            >
              <circle cx="66" cy="66" r={RING_R} fill="none" strokeWidth="6" className="stroke-foreground/[.12]" />
              <circle
                data-testid="break-ring"
                cx="66"
                cy="66"
                r={RING_R}
                fill="none"
                strokeWidth="6"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - frac)}
                className={danger ? "stroke-warning" : "stroke-primary"}
              />
            </svg>
            <div className="relative w-[100px]">
              <Countdown
                seconds={remaining}
                max={96}
                fixed={false}
                className={danger ? "text-warning-ink" : undefined}
              />
            </div>
          </div>
          <div className="flex flex-1 items-center gap-1.5">
            <Button
              variant="secondary"
              size="icon"
              aria-label={running ? "หยุดเวลาพักชั่วคราว" : "นับเวลาพักต่อ"}
              onClick={toggle}
            >
              {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              variant="secondary"
              size="icon"
              aria-label="เริ่มนับใหม่จากต้น"
              title="เริ่มนับใหม่จากต้น"
              onClick={reset}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" onClick={changeTime} title="ตั้งเวลาพักใหม่">
              เปลี่ยน
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => startWith(5 * 60)}>
            <span className="num text-[16px]">5</span> นาที
          </Button>
          <Button variant="secondary" onClick={() => startWith(10 * 60)}>
            <span className="num text-[16px]">10</span> นาที
          </Button>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              inputMode="numeric"
              aria-label="เวลาพัก (นาที)"
              min={1}
              max={180}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="num w-20 text-center"
            />
            <span className="text-[12.5px] text-muted-foreground">นาที</span>
            <Button onClick={() => startWith(Math.round(Number(custom) || 0) * 60)}>
              เริ่ม
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
