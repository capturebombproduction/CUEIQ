import Link from "next/link";
import { Brand } from "@/components/brand";
import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "เข้าสู่ระบบ" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-accent/40 to-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Brand size="lg" />
          <p className="mt-3 text-sm text-muted-foreground">
            Smart cues for every show.
          </p>
        </div>
        <LoginForm next={searchParams.next} />
        <p className="mt-6 text-center text-sm text-muted-foreground">
          ยังไม่มีบัญชี?{" "}
          <Link
            href="/register"
            className="font-medium text-primary hover:underline"
          >
            สมัครสมาชิก
          </Link>
        </p>
      </div>
    </main>
  );
}
