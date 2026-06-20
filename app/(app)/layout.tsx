import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/queries";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = await getWorkspace();
  if (!ws.user) redirect("/login");

  return (
    <div className="min-h-screen bg-muted/30">
      <SiteHeader
        name={ws.user.name}
        role={ws.membership?.role ?? null}
        perms={ws.perms}
      />
      <main className="container py-6">{children}</main>
    </div>
  );
}
