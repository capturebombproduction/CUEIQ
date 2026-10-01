import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "เข้าสู่ระบบ" };

// The first impression (spec §G.9): the dark stage itself — bg-background, no
// gradient wash — with one centred slab. The page light (round 3) is not decided
// yet, so nothing here paints any.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <LoginForm next={next} />
        <p className="mt-8 text-center text-[11px] text-faint">Designed by PatzNutthapat</p>
      </div>
    </main>
  );
}
