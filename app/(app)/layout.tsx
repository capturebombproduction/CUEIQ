import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/queries";
import { SiteHeader } from "@/components/site-header";
import { ErrorMonitor, AppErrorBoundary } from "@/components/error-monitor";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = await getWorkspace();
  if (!ws.user) redirect("/login");

  const tenantId = ws.membership?.tenant_id ?? null;

  return (
    <div className="min-h-screen bg-muted/30">
      {/* auto-capture client errors for the whole authenticated app */}
      <ErrorMonitor userId={ws.user.id} tenantId={tenantId} />
      <SiteHeader
        name={ws.user.name}
        role={ws.membership?.role ?? null}
        perms={ws.perms}
        userId={ws.user.id}
        tenantId={tenantId}
      />
      <main className="container py-6">
        <AppErrorBoundary userId={ws.user.id} tenantId={tenantId}>
          {children}
        </AppErrorBoundary>
      </main>
    </div>
  );
}
