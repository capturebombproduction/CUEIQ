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
  const supabase = await createClient();
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

/**
 * Look up a user's (synthetic) email — used for Master Admin protection.
 *
 * Read it from auth.users, NEVER from public.profiles: RLS (profiles_update_own)
 * lets any member rewrite their OWN profile row from the browser, so keying the
 * guard on profiles.email would let a member type the master admin's address into
 * it and make their own account unrevocable (delete + password reset would both
 * answer "Master Admin ถูกป้องกันไว้"). auth.users is service-role-only, so it is
 * the one identity a member cannot forge.
 *
 * `ok: false` = the lookup itself failed; callers must fail CLOSED rather than
 * read that as "not the master admin". A 404 (no such auth user — e.g. an orphaned
 * tenant_members row) resolves to a null email so that row can still be cleaned up.
 */
async function targetEmail(
  admin: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<{ ok: true; email: string | null } | { ok: false }> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error) {
    if (error.status === 404) return { ok: true, email: null };
    return { ok: false };
  }
  return { ok: true, email: data.user?.email ?? null };
}

/** Shared answer when targetEmail() can't resolve the target (fail closed). */
function lookupFailed() {
  return NextResponse.json(
    { error: "ตรวจสอบบัญชีปลายทางไม่สำเร็จ ลองใหม่อีกครั้ง" },
    { status: 503 }
  );
}

/**
 * Authoritative emails for every auth account, keyed by user id — so the admin
 * console shows the same identity the mutations are gated on. If it rendered
 * profiles.email, a member who spoofed theirs would appear AS the Master Admin
 * and the console would hide the very buttons that revoke them.
 *
 * Returns null when the listing fails; the caller then falls back to profiles.email
 * so a transient auth outage degrades to the old display instead of a blank list
 * (the mutations stay protected independently).
 */
async function authEmailById(
  admin: ReturnType<typeof createAdminClient>
): Promise<Map<string, string | null> | null> {
  const perPage = 200;
  const maxPages = 200; // bounded so the loop can never spin (200 × 200 = 40k accounts)
  const map = new Map<string, string | null>();
  // Stop on the first EMPTY page — a merely short one can just mean the server
  // clamped perPage, and breaking there would silently drop the rest.
  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) return null;
    const users = data.users ?? [];
    for (const u of users) map.set(u.id, u.email ?? null);
    if (users.length === 0) break;
  }
  return map;
}

/**
 * Is `userId` a member of THIS tenant? Guards the service-role mutations (which can
 * otherwise reach any account globally) so a tenant admin can only touch accounts
 * inside their own label — defense-in-depth for a future multi-tenant deployment.
 */
async function isTenantMember(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  userId: string
): Promise<boolean> {
  const { data } = await admin
    .from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
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

  const [membersRes, rolesRes, emailById] = await Promise.all([
    admin.from("tenant_members").select("user_id, role").eq("tenant_id", tenantId),
    admin.from("group_roles").select("user_id, group_id, role").eq("tenant_id", tenantId),
    authEmailById(admin),
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

  const users = members
    .map((m) => {
      const uid = m.user_id as string;
      const prof = profById.get(uid);
      return {
        user_id: uid,
        // authoritative auth email — profiles.email is member-writable (see targetEmail)
        email: emailById ? emailById.get(uid) ?? null : prof?.email ?? null,
        full_name: prof?.full_name ?? null,
        tenantRole: m.role as Role,
        groupRoles: groupRoles
          .filter((r) => r.user_id === uid)
          .map((r) => ({ group_id: r.group_id as string, role: r.role as GroupRole })),
      };
    })
    // same order as the server-rendered list (app/(app)/admin/page.tsx) so a
    // refresh doesn't reshuffle the console
    .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));

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
    if (grErr) {
      // roll back the half-created account (mirrors the memErr path) so a retry
      // is clean — otherwise re-submitting hits "user already registered"
      await admin.from("tenant_members").delete().eq("tenant_id", tenantId).eq("user_id", newId);
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      return NextResponse.json({ error: grErr.message }, { status: 400 });
    }
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
  // Two independent edits, either or both: change role/band roles, and/or reset
  // the password. The role fields are only validated/applied when provided, so a
  // pure password reset doesn't need to round-trip the role.
  const roleProvided = body?.tenantRole !== undefined && body?.tenantRole !== null;
  const tenantRole = body?.tenantRole as Role;
  const password = typeof body?.password === "string" ? body.password : undefined;

  if (!userId) {
    return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  }
  if (!roleProvided && password === undefined) {
    return NextResponse.json({ error: "ไม่มีอะไรให้แก้ไข" }, { status: 400 });
  }
  if (roleProvided && !TENANT_ROLES.includes(tenantRole)) {
    return NextResponse.json({ error: "ระดับสิทธิ์ไม่ถูกต้อง" }, { status: 400 });
  }
  if (password !== undefined && password.length < 8) {
    return NextResponse.json({ error: "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร" }, { status: 400 });
  }
  // don't let an admin strip their OWN admin rights (self-lockout guard)
  if (roleProvided && userId === gate.callerId && tenantRole !== "admin") {
    return NextResponse.json(
      { error: "เปลี่ยนสิทธิ์ตัวเองออกจากแอดมินไม่ได้" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // The target must belong to the caller's tenant — don't let a tenant admin reset
  // a password / change roles on an account outside their own label by guessing an id.
  if (userId !== gate.callerId && !(await isTenantMember(admin, gate.tenantId, userId))) {
    return NextResponse.json({ error: "ไม่พบผู้ใช้นี้ในค่ายของคุณ" }, { status: 404 });
  }

  // Master Admin can only be modified by itself — block other admins (covers both
  // the role change and the password reset).
  if (userId !== gate.callerId) {
    const target = await targetEmail(admin, userId);
    if (!target.ok) return lookupFailed();
    if (isMasterAdminEmail(target.email)) {
      return NextResponse.json(
        { error: "บัญชี Master Admin ถูกป้องกันไว้ คนอื่นแก้ไขไม่ได้" },
        { status: 403 }
      );
    }
  }

  // password reset — service-role sets it directly (synthetic @cueiq.local accounts
  // can't self-serve an email reset), takes effect on the user's next login.
  if (password !== undefined) {
    const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password });
    if (pwErr) return NextResponse.json({ error: pwErr.message }, { status: 400 });
  }

  if (roleProvided) {
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

  // The target must belong to the caller's tenant — deleteUser() removes the auth
  // account globally, so gate it on membership first (never reach another label).
  if (!(await isTenantMember(admin, tenantId, userId))) {
    return NextResponse.json({ error: "ไม่พบผู้ใช้นี้ในค่ายของคุณ" }, { status: 404 });
  }

  // Master Admin is protected — no one (not even other admins) can delete it.
  const target = await targetEmail(admin, userId);
  if (!target.ok) return lookupFailed();
  if (isMasterAdminEmail(target.email)) {
    return NextResponse.json(
      { error: "บัญชี Master Admin ถูกป้องกันไว้ ลบไม่ได้" },
      { status: 403 }
    );
  }

  // Delete the auth account FIRST — if it fails, the membership rows are still
  // intact so the user stays listed and the delete can simply be retried. (The old
  // order stripped memberships first; a failed deleteUser then left a live account
  // that the isTenantMember gate above turned into a permanent 404.)
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("group_roles").delete().eq("tenant_id", tenantId).eq("user_id", userId);
  await admin.from("tenant_members").delete().eq("tenant_id", tenantId).eq("user_id", userId);

  return NextResponse.json({ ok: true });
}
