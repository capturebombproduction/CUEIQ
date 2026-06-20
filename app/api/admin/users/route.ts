import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { isValidLoginId, loginIdToEmail } from "@/lib/username";
import { isMasterAdminEmail } from "@/lib/master-admin";
import type { GroupRole, Role } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TENANT_ROLES: Role[] = ["admin", "ceo", "label_staff", "artist_manager", "member"];
const GROUP_ROLES: GroupRole[] = ["artist_manager", "member"];

interface GroupRoleInput {
  group_id: string;
  role: GroupRole;
}

/**
 * Verify the CALLER is a tenant admin (via their own logged-in session + RLS),
 * and return their tenant id. The privileged work afterwards uses the service
 * role, so this gate is the only thing standing between a non-admin and the
 * admin API — keep it strict.
 */
async function requireAdmin(): Promise<
  | { ok: true; tenantId: string; callerId: string }
  | { ok: false; status: number; error: string }
> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "ไม่ได้เข้าสู่ระบบ" };

  const { data: member } = await supabase
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!member || member.role !== "admin") {
    return { ok: false, status: 403, error: "ต้องเป็นแอดมินเท่านั้น" };
  }
  return { ok: true, tenantId: member.tenant_id as string, callerId: user.id };
}

function serviceUnavailable() {
  return NextResponse.json(
    { error: "ยังไม่ได้ตั้งค่า SUPABASE_SERVICE_ROLE_KEY บนเซิร์ฟเวอร์" },
    { status: 503 }
  );
}

/** Keep only group roles whose group belongs to this tenant + has a valid role. */
function sanitizeGroupRoles(
  input: unknown,
  tenantGroupIds: Set<string>
): GroupRoleInput[] {
  if (!Array.isArray(input)) return [];
  const out: GroupRoleInput[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const gid = (raw as { group_id?: unknown })?.group_id;
    const role = (raw as { role?: unknown })?.role;
    if (typeof gid !== "string" || !tenantGroupIds.has(gid)) continue;
    if (typeof role !== "string" || !GROUP_ROLES.includes(role as GroupRole)) continue;
    if (seen.has(gid)) continue;
    seen.add(gid);
    out.push({ group_id: gid, role: role as GroupRole });
  }
  return out;
}

async function tenantGroupIdSet(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string
): Promise<Set<string>> {
  const { data } = await admin.from("groups").select("id").eq("tenant_id", tenantId);
  return new Set((data ?? []).map((g) => g.id as string));
}

/** Look up a user's (synthetic) email — used for Master Admin protection. */
async function targetEmail(
  admin: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<string | null> {
  const { data } = await admin
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  return (data?.email as string | null) ?? null;
}

// ---------------------------------------------------------------------------
// GET — list every user in the tenant with their tenant role + band roles.
// ---------------------------------------------------------------------------
export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!hasServiceRole()) return serviceUnavailable();

  const admin = createAdminClient();
  const { tenantId } = gate;

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

  const profById = new Map(
    (profiles ?? []).map((p) => [p.id as string, p])
  );

  const users = members.map((m) => {
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
  });

  return NextResponse.json({ users });
}

// ---------------------------------------------------------------------------
// POST — create a new account + assign its tenant role and per-band roles.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!hasServiceRole()) return serviceUnavailable();

  const body = await req.json().catch(() => null);
  const loginId = typeof body?.loginId === "string" ? body.loginId.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : "";
  const tenantRole = body?.tenantRole as Role;

  if (!isValidLoginId(loginId)) {
    return NextResponse.json({ error: "ชื่อผู้ใช้หรืออีเมลไม่ถูกต้อง" }, { status: 400 });
  }
  // bare usernames get wrapped into a synthetic internal email for GoTrue
  const email = loginIdToEmail(loginId);
  if (password.length < 8) {
    return NextResponse.json({ error: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร" }, { status: 400 });
  }
  if (!TENANT_ROLES.includes(tenantRole)) {
    return NextResponse.json({ error: "ระดับสิทธิ์ไม่ถูกต้อง" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { tenantId } = gate;
  const groupIds = await tenantGroupIdSet(admin, tenantId);
  const groupRoles = sanitizeGroupRoles(body?.groupRoles, groupIds);

  // 1) create the auth user (email pre-confirmed — no verification email)
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName || email.split("@")[0] },
  });
  if (createErr || !created?.user) {
    return NextResponse.json(
      { error: createErr?.message ?? "สร้างบัญชีไม่สำเร็จ" },
      { status: 400 }
    );
  }
  const newId = created.user.id;

  // 2) tenant membership (the handle_new_user trigger already made the profile)
  const { error: memErr } = await admin
    .from("tenant_members")
    .upsert({ tenant_id: tenantId, user_id: newId, role: tenantRole }, {
      onConflict: "tenant_id,user_id",
    });
  if (memErr) {
    // roll back the half-created account so a retry is clean
    await admin.auth.admin.deleteUser(newId).catch(() => {});
    return NextResponse.json({ error: memErr.message }, { status: 400 });
  }

  // 3) per-band roles
  if (groupRoles.length) {
    const { error: grErr } = await admin.from("group_roles").insert(
      groupRoles.map((g) => ({
        tenant_id: tenantId,
        group_id: g.group_id,
        user_id: newId,
        role: g.role,
      }))
    );
    if (grErr) return NextResponse.json({ error: grErr.message }, { status: 400 });
  }

  return NextResponse.json({
    user: {
      user_id: newId,
      email,
      full_name: fullName || email.split("@")[0],
      tenantRole,
      groupRoles,
    },
  });
}

// ---------------------------------------------------------------------------
// PATCH — change an existing user's tenant role + per-band roles.
// ---------------------------------------------------------------------------
export async function PATCH(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!hasServiceRole()) return serviceUnavailable();

  const body = await req.json().catch(() => null);
  const userId = typeof body?.user_id === "string" ? body.user_id : "";
  const tenantRole = body?.tenantRole as Role;
  if (!userId || !TENANT_ROLES.includes(tenantRole)) {
    return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  }
  // don't let an admin strip their OWN admin rights (self-lockout guard)
  if (userId === gate.callerId && tenantRole !== "admin") {
    return NextResponse.json(
      { error: "เปลี่ยนสิทธิ์ตัวเองออกจากแอดมินไม่ได้" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Master Admin can only be modified by itself — block other admins.
  if (userId !== gate.callerId && isMasterAdminEmail(await targetEmail(admin, userId))) {
    return NextResponse.json(
      { error: "บัญชี Master Admin ถูกป้องกันไว้ คนอื่นแก้ไขไม่ได้" },
      { status: 403 }
    );
  }

  const { tenantId } = gate;
  const groupIds = await tenantGroupIdSet(admin, tenantId);
  const groupRoles = sanitizeGroupRoles(body?.groupRoles, groupIds);

  const { error: memErr } = await admin
    .from("tenant_members")
    .upsert({ tenant_id: tenantId, user_id: userId, role: tenantRole }, {
      onConflict: "tenant_id,user_id",
    });
  if (memErr) return NextResponse.json({ error: memErr.message }, { status: 400 });

  // replace the user's band roles wholesale
  const { error: delErr } = await admin
    .from("group_roles")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  if (groupRoles.length) {
    const { error: grErr } = await admin.from("group_roles").insert(
      groupRoles.map((g) => ({
        tenant_id: tenantId,
        group_id: g.group_id,
        user_id: userId,
        role: g.role,
      }))
    );
    if (grErr) return NextResponse.json({ error: grErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE — remove a user entirely (auth + tenant/band rows).
// ---------------------------------------------------------------------------
export async function DELETE(req: Request) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!hasServiceRole()) return serviceUnavailable();

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id") ?? "";
  if (!userId) return NextResponse.json({ error: "ไม่มี user_id" }, { status: 400 });
  if (userId === gate.callerId) {
    return NextResponse.json({ error: "ลบบัญชีตัวเองไม่ได้" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { tenantId } = gate;

  // Master Admin is protected — no one (not even other admins) can delete it.
  if (isMasterAdminEmail(await targetEmail(admin, userId))) {
    return NextResponse.json(
      { error: "บัญชี Master Admin ถูกป้องกันไว้ ลบไม่ได้" },
      { status: 403 }
    );
  }

  await admin.from("group_roles").delete().eq("tenant_id", tenantId).eq("user_id", userId);
  await admin.from("tenant_members").delete().eq("tenant_id", tenantId).eq("user_id", userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
