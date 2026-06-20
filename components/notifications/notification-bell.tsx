"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NotifRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

type PushState = "unsupported" | "default" | "on" | "denied";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "เมื่อสักครู่";
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} วันก่อน`;
  return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function NotificationBell({
  userId,
  tenantId,
}: {
  userId: string;
  tenantId: string;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [items, setItems] = useState<NotifRow[]>([]);
  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<PushState>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const unread = items.filter((i) => !i.read_at).length;

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setItems(data as NotifRow[]);
  }, [supabase]);

  // initial load + poll on focus/visibility + a slow interval (no realtime: RLS
  // postgres_changes don't deliver on the publishable key, so we poll).
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const iv = setInterval(load, 45000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      clearInterval(iv);
    };
  }, [load]);

  // detect Web Push availability/state (no SW in dev → "unsupported")
  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !VAPID_PUBLIC) {
        setPushState("unsupported");
        return;
      }
      if (Notification.permission === "denied") return setPushState("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return setPushState("unsupported");
      const sub = await reg.pushManager.getSubscription();
      setPushState(sub ? "on" : "default");
    })().catch(() => setPushState("unsupported"));
  }, []);

  // close the panel on an outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function openItem(n: NotifRow) {
    setOpen(false);
    if (!n.read_at) {
      const now = new Date().toISOString();
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: now } : x)));
      // await before navigating — router.push tears the page down and would
      // cancel an in-flight PATCH, leaving the row unread on the next load.
      await supabase.from("notifications").update({ read_at: now }).eq("id", n.id);
    }
    if (n.link) router.push(n.link);
  }

  async function markAllRead() {
    if (unread === 0) return;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((x) => (x.read_at ? x : { ...x, read_at: now })));
    await supabase.from("notifications").update({ read_at: now }).is("read_at", null);
  }

  async function enablePush() {
    if (pushState === "unsupported" || !VAPID_PUBLIC) {
      toast.error("อุปกรณ์นี้ยังเปิดแจ้งเตือนเด้งไม่ได้ (ลองติดตั้งแอปลงหน้าจอโฮมก่อน)");
      return;
    }
    setPushBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushState(perm === "denied" ? "denied" : "default");
        toast.error("ยังไม่ได้อนุญาตแจ้งเตือน");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as BufferSource,
      });
      const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
      const { error } = await supabase.from("push_subscriptions").upsert(
        {
          user_id: userId,
          tenant_id: tenantId,
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
          user_agent: navigator.userAgent.slice(0, 200),
        },
        { onConflict: "endpoint" }
      );
      if (error) throw error;
      setPushState("on");
      toast.success("เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว 🔔");
    } catch (e) {
      toast.error("เปิดแจ้งเตือนเด้งไม่สำเร็จ", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="ghost"
        size="icon"
        title="การแจ้งเตือน"
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        <span className="sr-only">การแจ้งเตือน</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">การแจ้งเตือน</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Check className="h-3 w-3" /> อ่านทั้งหมด
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                ยังไม่มีการแจ้งเตือน
              </p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openItem(n)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/60",
                    !n.read_at && "bg-primary/5"
                  )}
                >
                  <div className="flex items-start gap-2">
                    {!n.read_at && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                    <span className={cn("flex-1 text-sm", !n.read_at && "font-medium")}>
                      {n.title}
                    </span>
                  </div>
                  {n.body && (
                    <span className="pl-4 text-xs text-muted-foreground">{n.body}</span>
                  )}
                  <span className="pl-4 text-[10px] text-muted-foreground/80">
                    {relTime(n.created_at)}
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Web Push opt-in (per device) */}
          <div className="border-t px-3 py-2">
            {pushState === "on" ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <BellRing className="h-3.5 w-3.5 text-success" /> เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว
              </p>
            ) : pushState === "denied" ? (
              <p className="text-xs text-muted-foreground">
                เบราว์เซอร์บล็อกการแจ้งเตือนไว้ — เปิดได้ที่ตั้งค่าเว็บไซต์
              </p>
            ) : pushState === "unsupported" ? (
              <p className="text-xs text-muted-foreground">
                เด้งถึงเครื่องได้เมื่อติดตั้งแอปลงหน้าจอโฮม (มือถือ) แล้วเปิดจากไอคอนแอป
              </p>
            ) : (
              <button
                type="button"
                onClick={enablePush}
                disabled={pushBusy}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 py-1.5 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-60"
              >
                {pushBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BellRing className="h-3.5 w-3.5" />
                )}
                เปิดแจ้งเตือนเด้งถึงเครื่อง
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
