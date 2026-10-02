"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AudioLines, Eye, EyeOff, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { loginIdToEmail } from "@/lib/username";
import { safeInternalPath } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The sign-in slab (spec §G.9): brand, a Thai line, two 16 px fields (the password
 * one with a show toggle) and one full-width primary. Shared verbatim by the web
 * login page and the desktop app's Login screen.
 *
 * The desktop smoke drives this form by id — `#loginId`, `#password`, and the
 * FIRST <form> on the page (desktop/electron/main.cjs signInThroughTheForm) — so
 * those ids stay, the show toggle only swaps the field's `type`, and nothing here
 * may add a second form above this one.
 *
 * A phone held sideways is ~390px tall, and the slab is ~480px: the sign-in button used
 * to land mostly below the fold. Under 500px of height the padding and gaps tighten
 * (the 48px fields and the 44px eye stay — they are the touch targets), which pulls
 * the button back inside the first screen.
 */
export function LoginForm({
  next,
  subtitle = "ระบบคิวโชว์ของค่าย — เข้าด้วยชื่อผู้ใช้ที่แอดมินสร้างให้",
}: {
  next?: string;
  /** The Thai line under the wordmark. */
  subtitle?: string;
}) {
  const router = useRouter();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: loginIdToEmail(loginId),
      password,
    });
    setLoading(false);
    if (error) {
      toast.error("เข้าสู่ระบบไม่สำเร็จ", { description: error.message });
      return;
    }
    toast.success("ยินดีต้อนรับกลับ");
    // startsWith("/") alone let `//evil.com` (protocol-relative) through → open redirect.
    router.replace(safeInternalPath(next));
    router.refresh();
  }

  return (
    <div className="slab rounded-[3px] p-6 [@media(max-height:500px)]:p-4">
      <div className="flex flex-col items-center text-center">
        <h1 className="flex items-center gap-3">
          <span className="brand-mark h-12 w-12 [@media(max-height:500px)]:h-9 [@media(max-height:500px)]:w-9" aria-hidden>
            <AudioLines className="h-6 w-6" strokeWidth={2.6} />
          </span>
          <span className="font-display-x text-[32px] font-extrabold uppercase italic leading-none tracking-[-.01em] [font-synthesis:none]">
            Cue<span className="text-primary-ink">IQ</span>
          </span>
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground [@media(max-height:500px)]:mt-1.5">{subtitle}</p>
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-4 [@media(max-height:500px)]:mt-3 [@media(max-height:500px)]:space-y-2">
        <div className="space-y-2">
          <Label htmlFor="loginId">ชื่อผู้ใช้</Label>
          <Input
            id="loginId"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={loginId}
            onChange={(e) => setLoginId(e.target.value)}
            placeholder="ชื่อผู้ใช้ของคุณ"
            className="h-12 text-base sm:text-base"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">รหัสผ่าน</Label>
          <div className="relative">
            <Input
              id="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="h-12 pr-12 text-base sm:text-base"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-pressed={show}
              aria-label={show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
              title={show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
              className="absolute right-0.5 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-[3px] text-muted-foreground transition-colors duration-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {show ? <EyeOff className="h-5 w-5" aria-hidden /> : <Eye className="h-5 w-5" aria-hidden />}
            </button>
          </div>
        </div>
        <Button type="submit" size="lg" className="w-full" disabled={loading}>
          {loading && <Loader2 className="animate-spin" aria-hidden />}
          {loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
        </Button>
      </form>

      <div className="mt-5 space-y-1 text-center text-[12.5px] leading-relaxed text-muted-foreground [@media(max-height:500px)]:mt-3">
        <p>ต้องการบัญชีเข้าใช้งาน? ติดต่อแอดมินค่าย</p>
        <p>ลืมรหัสผ่าน? ติดต่อแอดมินให้รีเซ็ตรหัสผ่านให้ (เข้าระบบแล้วเปลี่ยนรหัสเองได้)</p>
      </div>
    </div>
  );
}
