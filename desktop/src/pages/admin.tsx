// Desktop Admin — admin tasks (create accounts / roles / R2 storage / dev inbox)
// need server-side secrets (service_role + R2 keys) that the desktop renderer must
// NEVER bundle (see desktop/electron/main.cjs: auth stays in the renderer, no secret
// ships in the app). So Admin stays web-managed: this page opens the web Admin in the
// system browser. In Electron, main.cjs's setWindowOpenHandler routes window.open to
// shell.openExternal; in a plain browser it just opens a tab.
import { ShieldAlert, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isAdmin } from "@/lib/permissions";
import { useWorkspace } from "~/data/workspace-context";

const WEB_ADMIN_URL =
  (process.env.CUEIQ_WEB_ORIGIN ?? "https://cueiq-mu.vercel.app") + "/admin";

export function Admin() {
  const { ws } = useWorkspace();

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label
        </CardContent>
      </Card>
    );
  }
  if (!isAdmin(ws.perms)) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ไม่มีสิทธิ์เข้าหน้า Admin
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ShieldAlert className="h-6 w-6" /> Admin
        </h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} — จัดการผู้ใช้ / สิทธิ์ / พื้นที่จัดเก็บ / ฟีดแบค
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <ExternalLink className="h-10 w-10 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium">งาน Admin จัดการบนเว็บ</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              การสร้างบัญชี กำหนดบทบาท ดูพื้นที่จัดเก็บ (R2) และฟีดแบค ต้องใช้คีย์ลับฝั่งเซิร์ฟเวอร์
              จึงทำบนเว็บเพื่อความปลอดภัย — แอปเดสก์ท็อปนี้เน้นการรันโชว์ออฟไลน์
            </p>
          </div>
          <Button onClick={() => window.open(WEB_ADMIN_URL, "_blank", "noopener")}>
            <ExternalLink className="h-4 w-4" /> เปิดหน้า Admin บนเว็บ
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
