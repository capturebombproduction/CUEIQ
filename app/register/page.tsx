import Link from "next/link";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "สมัครสมาชิก" };

// Self-registration is CLOSED (RBAC lockdown, supabase/migrations/0016). Accounts
// are provisioned by an admin who assigns the tenant + per-band role. There is no
// public signup form anymore.
export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-accent/40 to-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Brand size="lg" />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>การสมัครเปิดเฉพาะแอดมิน</CardTitle>
            <CardDescription>
              ระบบนี้ใช้ภายในค่าย — บัญชีถูกสร้างและกำหนดสิทธิ์ (วง/บทบาท)
              โดยแอดมินเท่านั้น ไม่เปิดสมัครเอง ติดต่อแอดมินเพื่อขอบัญชีเข้าใช้งาน
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/login">ไปหน้าเข้าสู่ระบบ</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
