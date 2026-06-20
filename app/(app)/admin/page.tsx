import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { isAdmin } from "@/lib/permissions";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { UserManager, type ManagedUser } from "@/components/admin/user-manager";
import type { GroupRole, Role } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

async function listUsers(tenantId: string): Promise<ManagedUser[]> {
  const admin = createAdminClient();
  const [membersRes, rolesRes] = await Promise.all([
    admin.from("tenant_members").select("user_id, role").eq("tenant_id", tenantId),
    admin.from("group_roles").select("user_id, group_id, role").eq("tenant_id", tenantId),
  ]);
  const members = membersRes.data ?? [];
  const groupRoles = rolesRes.data ?? [];
  const userIds = members.map((m) => m.user_id as string);
  const { data: profiles } = userIds.length
    ? await admin.from("profiles").select("id, email, full_name").in("id", userIds)
    : { data: [] as { id: string; email: string | null; full_name: string | null }[] };
  const profById = new Map((profiles ?? []).map((p) => [p.id as string, p]));

  return members
    .map((m) => {
      const uid = m.user_id as string;
      const prof = profById.get(uid);
      return {
        user_id: uid,
        email: prof?.email ?? null,
        full_name: prof?.full_name ?? null,
        tenantRole: m.role as Role,
        groupRoles: groupRoles
          .filter((r) => r.user_id === uid)
          .map((r) => ({ group_id: r.group_id as string, role: r.role as GroupRole })),
      };
    })
    .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
}

export default async function AdminPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) redirect("/dashboard");
  if (!isAdmin(ws.perms)) redirect("/dashboard");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ShieldAlert className="h-6 w-6" /> ผู้ใช้ &amp; สิทธิ์
        </h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} — สร้างบัญชีและกำหนดบทบาทให้แต่ละคน (สมัครเองถูกปิดไว้)
        </p>
      </div>

      {!hasServiceRole() ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ต้องตั้งค่า service_role key ก่อน</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              การสร้างบัญชีใหม่ต้องใช้ <code>SUPABASE_SERVICE_ROLE_KEY</code> (คีย์ลับ)
              ซึ่งยังไม่ได้ตั้งค่าบนเซิร์ฟเวอร์
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Supabase Dashboard → Settings → API → <b>service_role</b> secret → คัดลอก</li>
              <li>
                วางใน <code>.env.local</code> เป็น{" "}
                <code>SUPABASE_SERVICE_ROLE_KEY=...</code> แล้วรีสตาร์ทเซิร์ฟเวอร์
              </li>
              <li>บน Vercel: Project → Settings → Environment Variables เพิ่มคีย์เดียวกัน</li>
            </ol>
            <p className="text-xs">
              ระหว่างนี้ยังกำหนดบทบาทให้คนที่มีบัญชีอยู่แล้วได้ — แต่ต้องมีคีย์ก่อนถึงจะสร้างบัญชีใหม่ได้
            </p>
          </CardContent>
        </Card>
      ) : (
        <UserManager
          currentUserId={ws.user?.id ?? ""}
          groups={ws.groups}
          initialUsers={await listUsers(ws.membership.tenant_id)}
        />
      )}
    </div>
  );
}
