import { LoginForm } from "@/components/auth/login-form";
import { StageLight } from "@/components/stage-light";

export const metadata = { title: "เข้าสู่ระบบ" };

// The first impression (spec v3 §G.9): the dark stage under the page light, with one
// centred slab. relative isolate: the light (z-index -1) paints over this screen's
// own background and under the slab.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="relative isolate flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 py-10">
      <StageLight />
      <div className="w-full max-w-sm">
        <LoginForm next={next} />
        <p className="mt-8 text-center text-[11px] text-faint">Designed by PatzNutthapat</p>
      </div>
    </main>
  );
}
