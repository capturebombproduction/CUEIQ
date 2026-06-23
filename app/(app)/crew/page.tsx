import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { canApprove } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import { StaffContactsManager } from "@/components/admin/staff-contacts";
import type { StaffContact } from "@/lib/types";

export const dynamic = "force-dynamic";

// The label crew directory (ช่างภาพ / ประสานงาน …) on its own page. Admin + label_staff
// own it (RLS 0032) — admins reach it from the nav instead of inside /admin, and
// label_staff (who can't open /admin) get a real page instead of the old collapsed
// block on /overview. The Overview "บันทึกเป็นรูป" export still pulls these contacts
// in automatically; this is just where they're maintained.
export default async function CrewPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) redirect("/dashboard");
  if (!canApprove(ws.perms)) redirect("/dashboard");

  const supabase = await createClient();
  const staffContacts = ((
    await supabase
      .from("staff_contacts")
      .select("*")
      .eq("tenant_id", ws.membership.tenant_id)
      .order("sort_order", { ascending: true })
  ).data ?? []) as StaffContact[];

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

      <StaffContactsManager
        tenantId={ws.membership.tenant_id}
        initial={staffContacts}
      />
    </div>
  );
}
