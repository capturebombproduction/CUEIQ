"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { cleanupPushOnSignOut } from "@/components/notifications/push-cleanup";
import { isLiveShowActive } from "@/lib/live-guard";
import { Button } from "@/components/ui/button";

/**
 * How many management writes the desktop still has queued offline (ops) or parked
 * as conflicts. Signing out on the desktop wipes BOTH stores
 * (desktop/src/App.tsx SIGNED_OUT → clearMgmtOutbox) and this product has no undo,
 * so we must ask before throwing that work away.
 *
 * Read straight from the same IndexedDB the outbox writes
 * (desktop/src/data/mgmt-outbox.ts) — the web bundle must not import desktop
 * modules, and the desktop read-cache is probed the same way in
 * components/event/show-readiness-check.tsx. On the web this database never
 * exists, so this always resolves 0: opened WITHOUT a version and aborted on
 * upgrade, so a probe can never create an empty (store-less) db that would then
 * break the outbox's own open.
 */
function countQueuedMgmtWork(): Promise<number> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(0);
      const req = indexedDB.open("cueiq-mgmt-outbox");
      req.onupgradeneeded = () => {
        try {
          req.transaction?.abort(); // never create it — this is a read-only probe
        } catch {
          /* aborting is best-effort */
        }
      };
      req.onerror = () => resolve(0);
      req.onblocked = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        const stores = ["ops", "conflicts"].filter((s) => db.objectStoreNames.contains(s));
        if (stores.length === 0) {
          db.close();
          return resolve(0);
        }
        let total = 0;
        const tx = db.transaction(stores, "readonly");
        for (const s of stores) {
          const c = tx.objectStore(s).count();
          c.onsuccess = () => {
            total += c.result;
          };
        }
        tx.oncomplete = () => {
          db.close();
          resolve(total);
        };
        tx.onerror = () => {
          db.close();
          resolve(0);
        };
        tx.onabort = () => {
          db.close();
          resolve(0);
        };
      };
    } catch {
      resolve(0);
    }
  });
}

/**
 * Web session storage is COOKIES (@supabase/ssr createBrowserClient), not
 * localStorage — expire every sb-*-auth-token cookie (including the .0/.1 chunks)
 * at the path the client writes them (DEFAULT_COOKIE_OPTIONS.path = "/").
 */
function dropAuthCookies(): void {
  try {
    for (const raw of document.cookie.split(";")) {
      const name = raw.split("=")[0]?.trim();
      if (name && /^sb-.+-auth-token/.test(name)) {
        document.cookie = `${name}=; Max-Age=0; path=/`;
      }
    }
  } catch {
    /* no document.cookie access — the local signOut below still tries */
  }
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        // Sign-out navigates programmatically, so Live Mode's <a>/beforeunload exit
        // guard can't intercept it — confirm here too so a mid-show tap can't drop
        // the operator to /login and cut a running show without warning.
        if (
          isLiveShowActive() &&
          !window.confirm(
            "กำลังรันโชว์อยู่ — ออกจากระบบตอนนี้จะหยุดเสียงและออกจากโชว์ ยืนยันไหม?"
          )
        ) {
          return;
        }
        // Shared band machine: a desktop sign-out wipes the offline management
        // outbox, so writes made at a no-internet venue would vanish before they
        // ever reached the server. Nothing here is recoverable — ask first, and
        // default to staying signed in. (Web: no outbox → count is 0 → no prompt.)
        const queued = await countQueuedMgmtWork();
        if (
          queued > 0 &&
          !window.confirm(
            `มีงานค้างซิงค์ ${queued} รายการที่ยังไม่ขึ้นออนไลน์ — ออกจากระบบตอนนี้จะทิ้งทั้งหมดและกู้คืนไม่ได้ (ต่อเน็ตแล้วกดชิป "ค้างซิงค์" ให้ซิงค์ก่อนดีกว่า) ยืนยันไหม?`
          )
        ) {
          return;
        }
        // Release this device's push subscription while the session (RLS) is
        // still alive — best-effort, never throws (see push-cleanup.ts).
        await cleanupPushOnSignOut();
        const supabase = createClient();
        const { error } = await supabase.auth.signOut();
        if (error) {
          // Dead network (offline venue): auth-js keeps the local session when
          // the server /logout call fails, so the tap would silently do nothing
          // — and the desktop's SIGNED_OUT cache/outbox wipe (shared band
          // machines, see desktop/src/App.tsx) would never run. Drop the
          // persisted session ourselves — the desktop client keeps it in
          // localStorage under sb-<ref>-auth-token, the WEB client keeps it in
          // cookies of the same name — a local-scope signOut then finds no access
          // token, skips the server, and DOES emit SIGNED_OUT — same end state as
          // an online sign-out, minus the server-side revoke.
          try {
            for (let i = window.localStorage.length - 1; i >= 0; i--) {
              const k = window.localStorage.key(i);
              if (k && /^sb-.+-auth-token/.test(k)) window.localStorage.removeItem(k);
            }
          } catch {
            /* unreadable storage — the local signOut below still tries */
          }
          dropAuthCookies();
          await supabase.auth.signOut({ scope: "local" }).catch(() => {});
          // If the session somehow survived all of that, going to /login would
          // just bounce off the middleware back to /dashboard (still signed in) —
          // which looks like the tap did nothing, on a device that is about to
          // change hands. Say so instead of pretending it worked.
          const stillOn = await supabase.auth
            .getSession()
            .then(({ data }) => !!data.session)
            .catch(() => false);
          if (stillOn) {
            toast.error("ออกจากระบบไม่สำเร็จ — ยังเข้าใช้งานด้วยบัญชีเดิมอยู่ ลองใหม่อีกครั้ง");
            return;
          }
        }
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut className="h-4 w-4" />
      <span className="hidden sm:inline">ออกจากระบบ</span>
    </Button>
  );
}
