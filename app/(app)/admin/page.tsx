import Link from "next/link";
import { redirect } from "next/navigation";
import { Inbox, Users } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { isAdmin } from "@/lib/permissions";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { UserManager, type ManagedUser } from "@/components/admin/user-manager";
import { DevInbox } from "@/components/admin/dev-inbox";
import { StorageUsage } from "@/components/admin/storage-usage";
import { BackupStatus } from "@/components/admin/backup-status";
import { getR2Usage, listBackups } from "@/lib/r2";
import type { GroupRole, Role } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageTitle } from "@/components/page-title";

export const dynamic = "force-dynamic";

/** A control-centre tile that is a way in (the More sheet's tile, as a link). */
const ADMIN_TILE =
  "well flex min-h-[94px] flex-col items-start rounded-[2px] p-3 text-left transition-colors duration-2 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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

/**
 * Display names for the Dev Inbox, keyed by user id.
 *
 * Resolved SERVER-side with the service role, exactly as listUsers() above does,
 * because `profiles` RLS is own-row-only with no admin exception — the inbox is a
 * client component and can never join it. That is why a feedback note showed only
 * a timestamp until now: nobody could tell whose bug it was, let alone answer it.
 */
async function feedbackNames(tenantId: string): Promise<Record<string, string>> {
  if (!hasServiceRole()) return {};
  const admin = createAdminClient();
  const { data: members } = await admin
    .from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId);
  const ids = (members ?? []).map((m) => m.user_id as string);
  if (!ids.length) return {};
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email, full_name")
    .in("id", ids);
  const out: Record<string, string> = {};
  for (const p of profiles ?? []) {
    const name = (p.full_name as string | null) || (p.email as string | null);
    if (name) out[p.id as string] = name;
  }
  return out;
}

export default async function AdminPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) redirect("/dashboard");
  if (!isAdmin(ws.perms)) redirect("/dashboard");

  // Live storage usage for the audio bucket — null if R2 isn't configured or the
  // list call fails (don't let it take the whole admin page down).
  const [r2usage, backups] = await Promise.all([
    getR2Usage().catch(() => null),
    listBackups().catch(() => []),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <PageTitle
          title="Admin"
          right={
            <span className="pb-0.5 text-right text-[13px] leading-tight text-muted-foreground">
              {ws.tenant.name}
            </span>
          }
        />
        <p className="text-[14px] text-muted-foreground">
          สร้างบัญชีและกำหนดบทบาทให้แต่ละคน (สมัครเองถูกปิดไว้) · ดูแลระบบสำรองข้อมูล พื้นที่ไฟล์ และฟีดแบค
        </p>
      </div>

      {/* The control centre: the system's health at a glance, then the ways in. */}
      <div className="grid gap-[2px] sm:grid-cols-2">
        <div className={r2usage ? undefined : "sm:col-span-2"}>
          <BackupStatus backups={backups} />
        </div>
        {r2usage && <StorageUsage bytes={r2usage.bytes} count={r2usage.count} />}
        <div className="grid grid-cols-2 gap-[2px] sm:col-span-2">
          <a href="#dev-inbox" className={ADMIN_TILE}>
            <Inbox className="h-[22px] w-[22px] text-primary-ink" aria-hidden />
            <span className="caps mt-2 text-[19px] leading-none tracking-[.03em]">Inbox</span>
            <span className="mt-1 text-[12px] leading-snug text-muted-foreground">
              ฟีดแบคจากทีม + error ที่ระบบจับได้
            </span>
          </a>
          <Link href="/crew" className={ADMIN_TILE}>
            <Users className="h-[22px] w-[22px] text-primary-ink" aria-hidden />
            <span className="caps mt-2 text-[19px] leading-none tracking-[.03em]">Crew</span>
            <span className="mt-1 text-[12px] leading-snug text-muted-foreground">
              ทีมงานประจำค่าย · ใส่ในรูปตารางงาน
            </span>
          </Link>
        </div>
      </div>

      <section className="space-y-3" aria-labelledby="admin-users">
        <h2 id="admin-users" className="h2">
          Users
        </h2>
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
      </section>

      <section
        id="dev-inbox"
        className="scroll-mt-[calc(var(--header-h)+env(safe-area-inset-top)+16px)] space-y-3"
        aria-labelledby="admin-inbox"
      >
        <div>
          <h2 id="admin-inbox" className="h2">
            Dev Inbox
          </h2>
          <p className="mt-1 text-[14px] text-muted-foreground">
            ข้อความที่ทีมส่งเข้ามา + error ที่ระบบจับได้อัตโนมัติ (เห็นเฉพาะแอดมิน)
          </p>
        </div>
        <DevInbox
          namesById={await feedbackNames(ws.membership.tenant_id)}
          adminUserId={ws.user?.id}
        />
      </section>
    </div>
  );
}
