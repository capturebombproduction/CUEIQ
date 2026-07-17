// Desktop Crew — mirrors app/(app)/crew/page.tsx. Reuses StaffContactsManager
// verbatim (the label crew directory: ช่างภาพ / ประสานงาน …). The browser client
// fetches staff_contacts under RLS (admin + label_staff), so no server route or
// secret is needed. Gate: canApprove (admins + label_staff).
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { RefreshButton } from "@/components/refresh-button";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { canApprove } from "@/lib/permissions";
import { StaffContactsManager } from "@/components/admin/staff-contacts";
import type { StaffContact } from "@/lib/types";
import { useWorkspace } from "~/data/workspace-context";

export function Crew() {
  const { ws } = useWorkspace();
  const [staff, setStaff] = useState<StaffContact[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!ws?.membership) return;
    let alive = true;
    createClient()
      .from("staff_contacts")
      .select("*")
      .eq("tenant_id", ws.membership.tenant_id)
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (!alive) return;
        // postgrest resolves offline/network failures as { data: null, error } —
        // don't render an empty crew list for a failed read.
        if (error) {
          setLoadError(true);
          return;
        }
        setLoadError(false);
        setStaff((data ?? []) as StaffContact[]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id]);

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label
        </CardContent>
      </Card>
    );
  }
  if (!canApprove(ws.perms)) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ไม่มีสิทธิ์เข้าหน้า Crew
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Users className="h-6 w-6" /> Crew
        </h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} · ทีมงานประจำค่าย — ระบบใส่ลงในรูป “บันทึกเป็นรูป” ของหน้า Overview
          ให้อัตโนมัติทุกงาน
        </p>
      </div>
      {staff === null && loadError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
            <p>โหลดข้อมูลทีมงานไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
            <RefreshButton label="ลองใหม่" />
          </CardContent>
        </Card>
      ) : staff === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : (
        <StaffContactsManager tenantId={ws.membership.tenant_id} initial={staff} />
      )}
    </div>
  );
}
