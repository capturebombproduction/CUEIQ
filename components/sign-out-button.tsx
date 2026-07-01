"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
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
        await createClient().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut className="h-4 w-4" />
      <span className="hidden sm:inline">ออกจากระบบ</span>
    </Button>
  );
}
