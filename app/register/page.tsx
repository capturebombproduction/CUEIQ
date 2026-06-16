import Link from "next/link";
import { Brand } from "@/components/brand";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata = { title: "สมัครสมาชิก" };

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-accent/40 to-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Brand size="lg" />
          <p className="mt-3 text-sm text-muted-foreground">
            สร้างบัญชีเพื่อเริ่มจัดการโชว์
          </p>
        </div>
        <RegisterForm />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          มีบัญชีอยู่แล้ว?{" "}
          <Link
            href="/login"
            className="font-medium text-primary hover:underline"
          >
            เข้าสู่ระบบ
          </Link>
        </p>
      </div>
    </main>
  );
}
