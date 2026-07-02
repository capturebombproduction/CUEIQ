// Header chips for the offline-management outbox (⭐#1 step 2):
//   • "ค้างซิงค์ N" (amber) — writes queued while offline; click = flush now.
//     Also auto-flushes on boot and whenever the network returns (the management
//     counterpart of components/outbox-flusher.tsx, which drains show-run data).
//   • "ชนกัน N" (red) — queued writes the online-wins guard parked because the
//     server changed first. Click opens a panel to resolve each one:
//     ใช้ของฉัน (force-write over the server) / ใช้ของออนไลน์ (discard mine).
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { describeOp } from "@/lib/mgmt-outbox";
import { Button } from "@/components/ui/button";
import {
  MGMT_OUTBOX_EVENT,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtCount,
  resolveMgmtConflict,
  type ConflictRec,
} from "~/data/mgmt-outbox";

export function MgmtSyncStatus() {
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<{ key: number; rec: ConflictRec }[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const [p, c] = await Promise.all([pendingMgmtCount(), listMgmtConflicts()]);
    if (!alive.current) return;
    setPending(p);
    setConflicts(c);
    if (c.length === 0) setOpen(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    const flushAndRefresh = () => {
      if (navigator.onLine !== false) flushMgmtOutbox().catch(() => {});
      refresh();
    };
    flushAndRefresh(); // boot: drain anything a previous offline session left queued
    window.addEventListener("online", flushAndRefresh);
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      alive.current = false;
      window.removeEventListener("online", flushAndRefresh);
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, [refresh]);

  async function syncNow() {
    setBusy(true);
    const res = await flushMgmtOutbox().catch(() => null);
    setBusy(false);
    if (res && res.flushed > 0 && res.remaining === 0 && res.parked === 0) {
      toast.success(`ซิงค์แล้ว ${res.flushed} รายการ`);
    } else if (res && res.remaining > 0) {
      toast.info("ยังออฟไลน์อยู่ — จะซิงค์ให้อัตโนมัติเมื่อเน็ตกลับ");
    }
    refresh();
  }

  async function resolve(key: number, choice: "mine" | "server") {
    setBusy(true);
    const ok = await resolveMgmtConflict(key, choice);
    setBusy(false);
    if (!ok) toast.error("เขียนทับไม่สำเร็จ — ลองใหม่เมื่อออนไลน์");
    refresh();
  }

  if (pending === 0 && conflicts.length === 0) return null;

  return (
    <div className="relative flex items-center gap-1.5">
      {pending > 0 && (
        <button
          type="button"
          onClick={syncNow}
          disabled={busy}
          title="มีรายการที่บันทึกไว้ตอนออฟไลน์ รอซิงค์ขึ้นออนไลน์ — กดเพื่อลองซิงค์เดี๋ยวนี้"
          className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-600 ring-1 ring-amber-500/40 hover:bg-amber-500/25 dark:text-amber-400"
        >
          <RefreshCw className={busy ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          ค้างซิงค์ {pending}
        </button>
      )}
      {conflicts.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="รายการที่ชนกับเวอร์ชันออนไลน์ — กดเพื่อเลือกว่าจะใช้ของเครื่องนี้หรือของออนไลน์"
          className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive ring-1 ring-destructive/40 hover:bg-destructive/25"
        >
          <AlertTriangle className="h-3 w-3" />
          ชนกัน {conflicts.length}
        </button>
      )}
      {open && conflicts.length > 0 && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[22rem] max-w-[90vw] rounded-lg border bg-background p-3 shadow-lg">
          <p className="mb-2 text-xs text-muted-foreground">
            รายการเหล่านี้ถูกแก้บนออนไลน์ใหม่กว่าที่เครื่องนี้แก้ตอนออฟไลน์ — เลือกว่าจะเก็บฝั่งไหน
          </p>
          <div className="space-y-2">
            {conflicts.map(({ key, rec }) => (
              <div key={key} className="rounded-md border p-2">
                <p className="text-sm font-medium">{describeOp(rec.op)}</p>
                <p className="text-xs text-muted-foreground">{rec.reason}</p>
                <div className="mt-1.5 flex gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => resolve(key, "mine")}
                  >
                    ใช้ของฉัน (เขียนทับ)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => resolve(key, "server")}
                  >
                    ใช้ของออนไลน์
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
