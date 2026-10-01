import Link from "next/link";
import { AudioLines, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = { title: "สมัครสมาชิก" };

// Self-registration is CLOSED (RBAC lockdown, supabase/migrations/0016). Accounts
// are provisioned by an admin who assigns the tenant + per-band role. There is no
// public signup form anymore.
export default function RegisterPage() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="slab rounded-[3px] p-6 text-center">
          <span className="inline-flex items-center gap-3">
            <span className="brand-mark h-12 w-12" aria-hidden>
              <AudioLines className="h-6 w-6" strokeWidth={2.6} />
            </span>
            <span className="font-display-x text-[32px] font-extrabold uppercase italic leading-none tracking-[-.01em] [font-synthesis:none]">
              Cue<span className="text-primary-ink">IQ</span>
            </span>
          </span>
          <h1 className="mt-5 text-xl font-semibold">การสมัครเปิดเฉพาะแอดมิน</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
            ระบบนี้ใช้ภายในค่าย — บัญชีถูกสร้างและกำหนดสิทธิ์ (วง/บทบาท)
            โดยแอดมินเท่านั้น ไม่เปิดสมัครเอง ติดต่อแอดมินเพื่อขอบัญชีเข้าใช้งาน
          </p>
          <Button asChild size="lg" className="mt-6 w-full">
            <Link href="/login">
              <LogIn aria-hidden /> ไปหน้าเข้าสู่ระบบ
            </Link>
          </Button>
        </div>
        <p className="mt-8 text-center text-[11px] text-faint">Designed by PatzNutthapat</p>
      </div>
    </main>
  );
}
