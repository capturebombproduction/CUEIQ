"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, UserPlus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ROLE_LABELS,
  ROLE_SHORT,
  type Group,
  type GroupRole,
  type Role,
} from "@/lib/types";
import { displayLoginId } from "@/lib/username";

export interface ManagedUser {
  user_id: string;
  email: string | null;
  full_name: string | null;
  tenantRole: Role;
  groupRoles: { group_id: string; role: GroupRole }[];
}

// The access level the admin picks. Label-wide levels map straight to a tenant
// role; "band" means a band-scoped user (inert tenant role + per-band roles).
type AccessLevel = "admin" | "ceo" | "label_staff" | "band";
type BandRole = "none" | "member" | "artist_manager";

const ACCESS_OPTIONS: { value: AccessLevel; label: string; hint: string }[] = [
  { value: "admin", label: "Admin", hint: "ดูแล/แก้ไขทุกวง + จัดการผู้ใช้" },
  { value: "ceo", label: "CEO", hint: "เห็นทุกวง (ดูอย่างเดียว)" },
  { value: "label_staff", label: "Label Staff", hint: "หน้าภาพรวม + อนุมัติเพลง/งาน + เวลาถ่ายรูป" },
  { value: "band", label: "เฉพาะวง (Ar/สมาชิก)", hint: "เห็นเฉพาะวงที่ได้รับมอบหมาย" },
];

const BAND_ROLE_LABELS: Record<BandRole, string> = {
  none: "—",
  member: "สมาชิก (ดูอย่างเดียว)",
  artist_manager: "Ar (แก้ไขวงได้)",
};

function levelOf(u: ManagedUser): AccessLevel {
  if (u.tenantRole === "admin" || u.tenantRole === "ceo" || u.tenantRole === "label_staff") {
    return u.tenantRole;
  }
  return "band";
}

interface FormState {
  loginId: string;
  password: string;
  full_name: string;
  level: AccessLevel;
  bandRoles: Record<string, BandRole>;
}

function emptyForm(): FormState {
  return { loginId: "", password: "", full_name: "", level: "band", bandRoles: {} };
}

export function UserManager({
  currentUserId,
  groups,
  initialUsers,
}: {
  currentUserId: string;
  groups: Group[];
  initialUsers: ManagedUser[];
}) {
  const [users, setUsers] = useState<ManagedUser[]>(initialUsers);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [busy, setBusy] = useState(false);

  const groupName = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.id, g.name])),
    [groups]
  );

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setOpen(true);
  }

  function openEdit(u: ManagedUser) {
    setEditing(u);
    const bandRoles: Record<string, BandRole> = {};
    for (const gr of u.groupRoles) bandRoles[gr.group_id] = gr.role;
    setForm({
      loginId: displayLoginId(u.email),
      password: "",
      full_name: u.full_name ?? "",
      level: levelOf(u),
      bandRoles,
    });
    setOpen(true);
  }

  async function refresh() {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const json = await res.json();
      setUsers(json.users as ManagedUser[]);
    }
  }

  function buildPayload() {
    const tenantRole: Role = form.level === "band" ? "member" : form.level;
    const groupRoles =
      form.level === "band"
        ? Object.entries(form.bandRoles)
            .filter(([, r]) => r !== "none")
            .map(([group_id, r]) => ({ group_id, role: r as GroupRole }))
        : [];
    return { tenantRole, groupRoles };
  }

  async function submit() {
    const { tenantRole, groupRoles } = buildPayload();
    if (form.level === "band" && groupRoles.length === 0) {
      toast.error("เลือกบทบาทอย่างน้อยหนึ่งวงให้ผู้ใช้แบบเฉพาะวง");
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        const res = await fetch("/api/admin/users", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: editing.user_id,
            tenantRole,
            groupRoles,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "บันทึกไม่สำเร็จ");
        toast.success("อัปเดตสิทธิ์แล้ว");
      } else {
        const res = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            loginId: form.loginId,
            password: form.password,
            full_name: form.full_name,
            tenantRole,
            groupRoles,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "สร้างบัญชีไม่สำเร็จ");
        toast.success(`สร้างบัญชี ${form.loginId} แล้ว`);
      }
      setOpen(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: ManagedUser) {
    if (!window.confirm(`ลบบัญชี ${displayLoginId(u.email) || u.user_id}? กู้คืนไม่ได้`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users?user_id=${encodeURIComponent(u.user_id)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "ลบไม่สำเร็จ");
      toast.success("ลบบัญชีแล้ว");
      setUsers((prev) => prev.filter((x) => x.user_id !== u.user_id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{users.length} บัญชี</span>
        <Button onClick={openCreate}>
          <UserPlus className="h-4 w-4" /> สร้างบัญชีใหม่
        </Button>
      </div>

      <div className="space-y-2">
        {users.map((u) => {
          const level = levelOf(u);
          return (
            <Card key={u.user_id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">
                      {u.full_name || displayLoginId(u.email) || u.user_id}
                    </span>
                    {u.user_id === currentUserId && (
                      <Badge variant="outline" className="text-[10px]">
                        คุณ
                      </Badge>
                    )}
                  </div>
                  {u.email && (
                    <div className="truncate text-xs text-muted-foreground">
                      {displayLoginId(u.email)}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge variant="secondary" className="gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      {level === "band" ? "เฉพาะวง" : ROLE_SHORT[u.tenantRole]}
                    </Badge>
                    {u.groupRoles.map((gr) => (
                      <Badge key={gr.group_id} variant="outline" className="text-[10px]">
                        {groupName[gr.group_id] ?? "?"} ·{" "}
                        {gr.role === "artist_manager" ? "Ar" : "สมาชิก"}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(u)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {u.user_id !== currentUserId && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => remove(u)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "แก้ไขสิทธิ์ผู้ใช้" : "สร้างบัญชีใหม่"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `${displayLoginId(editing.email) || editing.user_id}`
                : "ตั้งชื่อผู้ใช้ + รหัสผ่านให้ผู้ใช้ แล้วกำหนดบทบาท (ผู้ใช้เปลี่ยนรหัสเองทีหลังได้)"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!editing && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="u-login">ชื่อผู้ใช้ *</Label>
                  <Input
                    id="u-login"
                    type="text"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={form.loginId}
                    onChange={(e) => setForm((f) => ({ ...f, loginId: e.target.value }))}
                    placeholder="เช่น ar01"
                  />
                  <p className="text-xs text-muted-foreground">
                    ใช้ชื่อผู้ใช้สั้น ๆ ก็ได้ ไม่จำเป็นต้องเป็นอีเมลจริง — ผู้ใช้ล็อกอินด้วยชื่อนี้
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="u-name">ชื่อ</Label>
                    <Input
                      id="u-name"
                      value={form.full_name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, full_name: e.target.value }))
                      }
                      placeholder="ชื่อที่แสดง"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="u-pass">รหัสผ่าน *</Label>
                    <Input
                      id="u-pass"
                      type="text"
                      value={form.password}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, password: e.target.value }))
                      }
                      placeholder="อย่างน้อย 8 ตัว"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label>ระดับสิทธิ์</Label>
              <Select
                value={form.level}
                onValueChange={(v) => setForm((f) => ({ ...f, level: v as AccessLevel }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {ACCESS_OPTIONS.find((o) => o.value === form.level)?.hint}
              </p>
            </div>

            {form.level === "band" && (
              <div className="space-y-2">
                <Label>บทบาทในแต่ละวง</Label>
                {groups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">ยังไม่มีวง</p>
                ) : (
                  <div className="space-y-2 rounded-lg border p-3">
                    {groups.map((g) => (
                      <div key={g.id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm">{g.name}</span>
                        <Select
                          value={form.bandRoles[g.id] ?? "none"}
                          onValueChange={(v) =>
                            setForm((f) => ({
                              ...f,
                              bandRoles: { ...f.bandRoles, [g.id]: v as BandRole },
                            }))
                          }
                        >
                          <SelectTrigger className="w-44 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(["none", "member", "artist_manager"] as BandRole[]).map((r) => (
                              <SelectItem key={r} value={r}>
                                {BAND_ROLE_LABELS[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {editing && (
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                บทบาทปัจจุบัน: {ROLE_LABELS[editing.tenantRole]}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                <Pencil className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {editing ? "บันทึก" : "สร้างบัญชี"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
