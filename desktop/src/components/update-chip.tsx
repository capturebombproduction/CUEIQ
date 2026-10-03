// The desktop header's update control (พี่, 2026-10-03: "อยากให้เวอร์ชันเดสก์ท็อปและแมคกดอัปเดตได้").
// พี่ again (2026-10-03): "กดอัพเดทเหมือนอัพเดทเกมส์" — on both platforms the chip is
// "อัปเดต" → n% → "ติดตั้ง"; when the download finishes main itself asks "เปิดใหม่เลย?".
// It shows only when there is something to press — a newer version, its download, or one
// ready to install — and reads/drives the one state the main process keeps
// (desktop/electron/main.cjs checkForUpdates / applyUpdate). Every decision that can quit the
// app (a show running, an unsaved edit, the .dmg steps on a Mac that cannot update itself)
// is made in main, never here. Not mounted on Live / the show-caller (no header there).
import { useEffect, useState } from "react";
import { Download, Loader2, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

const CHIP =
  "caps flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-3 text-[14px] leading-none transition-colors duration-2";

export function UpdateChip() {
  const api = typeof window !== "undefined" ? window.cueiqNative?.updates : undefined;
  const [s, setS] = useState<CueiqUpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const off = api.onChange((next) => {
      if (alive) setS(next);
    });
    api.get().then(
      (now) => {
        if (alive) setS((prev) => prev ?? now); // a change that already arrived is newer
      },
      () => {}
    );
    return () => {
      alive = false;
      off?.();
    };
  }, [api]);

  if (!api || !s) return null;

  const press = () => {
    if (busy) return;
    setBusy(true);
    api.apply().then(
      (next) => {
        setS(next);
        setBusy(false);
      },
      () => setBusy(false)
    );
  };
  // a Mac that cannot replace itself (run from the .dmg, older release…): the press opens the .dmg
  const manual = s.platform === "darwin" && s.manual === true;

  if (s.state === "available") {
    return (
      <button
        type="button"
        onClick={press}
        disabled={busy}
        data-testid="update-chip"
        className={cn(CHIP, "bg-primary text-primary-foreground hover:bg-primary/90")}
        title={
          manual
            ? `เวอร์ชันใหม่ ${s.latest} — กดเพื่อโหลดไฟล์ติดตั้ง (.dmg) สำหรับ Mac เครื่องนี้`
            : `เวอร์ชันใหม่ ${s.latest} — กดเพื่อโหลด (ราว 100 MB) โหลดเสร็จแล้วแอปจะถามก่อนเปิดใหม่`
        }
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        {manual ? "ดาวน์โหลด" : "อัปเดต"} <span className="num">{s.latest}</span>
      </button>
    );
  }
  if (s.state === "downloading") {
    return (
      <span
        data-testid="update-chip"
        role="status"
        className={cn(CHIP, "text-muted-foreground shadow-[inset_0_0_0_1.5px_hsl(var(--border))]")}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        กำลังโหลด <span className="num">{s.percent ?? 0}%</span>
      </span>
    );
  }
  if (s.state === "ready") {
    return (
      <button
        type="button"
        onClick={press}
        disabled={busy}
        data-testid="update-chip"
        className={cn(CHIP, "bg-primary text-primary-foreground hover:bg-primary/90")}
        title={`ติดตั้งเวอร์ชัน ${s.latest} — แอปจะปิดแล้วเปิดใหม่เป็นเวอร์ชันใหม่เอง (ไม่ติดตั้งระหว่างโชว์)`}
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden />
        ติดตั้ง <span className="num">{s.latest}</span>
      </button>
    );
  }
  return null;
}
