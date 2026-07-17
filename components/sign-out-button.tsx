"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cleanupPushOnSignOut } from "@/components/notifications/push-cleanup";
import { isLiveShowActive } from "@/lib/live-guard";
import { Button } from "@/components/ui/button";

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
          // persisted session ourselves (the desktop client stores it in
          // localStorage under sb-<ref>-auth-token); a local-scope signOut then
          // finds no access token, skips the server, and DOES emit SIGNED_OUT —
          // same end state as an online sign-out, minus the server-side revoke.
          try {
            for (let i = window.localStorage.length - 1; i >= 0; i--) {
              const k = window.localStorage.key(i);
              if (k && /^sb-.+-auth-token/.test(k)) window.localStorage.removeItem(k);
            }
          } catch {
            /* unreadable storage — the local signOut below still tries */
          }
          await supabase.auth.signOut({ scope: "local" }).catch(() => {});
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
