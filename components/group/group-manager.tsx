"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Users } from "lucide-react";
import { BulkAddMembers } from "@/components/group/bulk-add-members";
import { createClient } from "@/lib/supabase/client";
import { removeEventAudio } from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { canEditGroup, isAdmin, type Perms } from "@/lib/permissions";
import type { Group, Member } from "@/lib/types";

export function GroupManager({
  tenantId,
  initialGroups,
  initialMembers,
  perms,
}: {
  tenantId: string;
  initialGroups: Group[];
  initialMembers: Member[];
  perms: Perms;
}) {
  const supabase = createClient();
  const [groups, setGroups] = useState<Group[]>(initialGroups);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);

  // Create/delete a band + its settings (name/color/skin) = admin only.
  // Editing a band's roster (members) = admin OR that band's Artist Manager.
  const admin = isAdmin(perms);
  const canEditRoster = (groupId: string) => canEditGroup(perms, groupId);

  const membersOf = (gid: string) =>
    members
      .filter((m) => m.group_id === gid)
      .sort((a, b) => a.sort_order - b.sort_order);

  // ---- group operations ----------------------------------------------------
  async function addGroup() {
    const name = newGroup.trim();
    if (!name) {
      toast.error("ใส่ชื่อวงก่อน");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase
      .from("groups")
      .insert({ tenant_id: tenantId, name, color: "#7c3aed" })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error("เพิ่มวงไม่สำเร็จ", { description: error?.message });
      return;
    }
    setGroups((prev) => [...prev, data as Group]);
    setNewGroup("");
    toast.success(`เพิ่มวง ${name} แล้ว 🎶`);
  }

  function setGroupLocal(id: string, partial: Partial<Group>) {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...partial } : g)));
  }
  async function persistGroup(id: string, partial: Partial<Group>) {
    const { error } = await supabase.from("groups").update(partial).eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
  }

  async function deleteGroup(g: Group) {
    if (
      !window.confirm(
        `ลบวง "${g.name}"?\n\n⚠️ จะลบสมาชิก เพลงในคลัง และงานทั้งหมดของวงนี้ด้วย — กู้คืนไม่ได้`
      )
    )
      return;
    // Gather the R2 audio keys this delete will orphan BEFORE the DB cascade wipes
    // the rows: every library song's file + any legacy per-item file on the group's
    // events. (The cascade only removes DB rows, not the R2 objects.)
    const r2Keys = new Set<string>();
    const { data: songRows } = await supabase
      .from("songs")
      .select("audio_path")
      .eq("group_id", g.id);
    (songRows ?? []).forEach((s) => s.audio_path && r2Keys.add(s.audio_path));
    const { data: evRows } = await supabase
      .from("events")
      .select("id")
      .eq("group_id", g.id);
    const evIds = (evRows ?? []).map((e) => e.id as string);
    if (evIds.length) {
      const { data: itemRows } = await supabase
        .from("setlist_items")
        .select("audio_path")
        .in("event_id", evIds)
        .not("audio_path", "is", null);
      (itemRows ?? []).forEach((i) => i.audio_path && r2Keys.add(i.audio_path));
    }

    const snapG = groups;
    const snapM = members;
    setGroups((prev) => prev.filter((x) => x.id !== g.id));
    setMembers((prev) => prev.filter((m) => m.group_id !== g.id));
    const { error } = await supabase.from("groups").delete().eq("id", g.id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setGroups(snapG);
      setMembers(snapM);
      return;
    }
    // DB cascade done → reclaim the R2 objects (best-effort, after the row is gone).
    r2Keys.forEach((key) => removeEventAudio(key).catch(() => {}));
  }

  // ---- member operations ---------------------------------------------------
  async function addMember(groupId: string) {
    const gm = membersOf(groupId);
    const sort = gm.length ? Math.max(...gm.map((m) => m.sort_order)) + 1 : 1;
    const { data, error } = await supabase
      .from("members")
      .insert({
        tenant_id: tenantId,
        group_id: groupId,
        name: "",
        sort_order: sort,
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มสมาชิกไม่สำเร็จ", { description: error?.message });
      return;
    }
    setMembers((prev) => [...prev, data as Member]);
  }

  async function bulkAddMembers(groupId: string, text: string) {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    const gm = membersOf(groupId);
    let sort = gm.length ? Math.max(...gm.map((m) => m.sort_order)) + 1 : 1;
    const rows = lines.map((line) => {
      const [name, nickname, micStr] = line.split(",").map((s) => s.trim());
      const mic = micStr ? parseInt(micStr, 10) : NaN;
      return {
        tenant_id: tenantId,
        group_id: groupId,
        name: name || "",
        nickname: nickname || null,
        mic_number: Number.isNaN(mic) ? null : mic,
        sort_order: sort++,
      };
    });
    const { data, error } = await supabase.from("members").insert(rows).select("*");
    if (error || !data) {
      toast.error("เพิ่มสมาชิกไม่สำเร็จ", { description: error?.message });
      return;
    }
    setMembers((prev) => [...prev, ...(data as Member[])]);
    toast.success(`เพิ่ม ${data.length} คนแล้ว`);
  }

  function setMemberLocal(id: string, partial: Partial<Member>) {
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...partial } : m))
    );
  }
  async function persistMember(id: string, partial: Partial<Member>) {
    const { error } = await supabase.from("members").update(partial).eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
  }

  async function deleteMember(id: string) {
    const snap = members;
    setMembers((prev) => prev.filter((m) => m.id !== id));
    const { error } = await supabase.from("members").delete().eq("id", id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setMembers(snap);
    }
  }

  return (
    <div className="space-y-6">
      {admin && (
        <div className="flex gap-2">
          <Input
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
            }}
            placeholder="ชื่อวงใหม่ (เช่น Seishin Kakumei)"
            className="max-w-xs"
          />
          <Button onClick={addGroup} disabled={busy}>
            <Plus className="h-4 w-4" /> เพิ่มวง
          </Button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
          <Users className="h-10 w-10 text-muted-foreground" />
          <p className="text-muted-foreground">ยังไม่มีวง</p>
        </div>
      ) : (
        groups.map((g) => {
          const gm = membersOf(g.id);
          return (
            <Card key={g.id}>
              <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
                <input
                  type="color"
                  value={g.color ?? "#7c3aed"}
                  disabled={!admin}
                  onChange={(e) => setGroupLocal(g.id, { color: e.target.value })}
                  onBlur={(e) => persistGroup(g.id, { color: e.target.value })}
                  className="h-8 w-8 shrink-0 cursor-pointer rounded border bg-transparent"
                  aria-label="สีวง"
                />
                <Input
                  value={g.name}
                  disabled={!admin}
                  onChange={(e) => setGroupLocal(g.id, { name: e.target.value })}
                  onBlur={(e) =>
                    persistGroup(g.id, { name: e.target.value.trim() || g.name })
                  }
                  className="h-9 max-w-xs flex-1 text-base font-semibold"
                />
                <Badge variant="secondary">{gm.length} คน</Badge>
                {admin &&
                  (g.skin ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>ธีมแอป</span>
                      <input
                        type="color"
                        value={g.skin}
                        onChange={(e) => setGroupLocal(g.id, { skin: e.target.value })}
                        onBlur={(e) => persistGroup(g.id, { skin: e.target.value })}
                        className="h-7 w-7 shrink-0 cursor-pointer rounded border bg-transparent"
                        aria-label="สีธีมทั้งแอปของวง"
                        title="สีธีมทั้งแอปเวลาดูงานของวงนี้"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setGroupLocal(g.id, { skin: null });
                          persistGroup(g.id, { skin: null });
                        }}
                        className="rounded px-1.5 py-0.5 hover:bg-muted"
                      >
                        ปิด
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        const hex = g.color ?? "#7c3aed";
                        setGroupLocal(g.id, { skin: hex });
                        persistGroup(g.id, { skin: hex });
                      }}
                      className="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                      title="ทำให้ทั้งแอปเป็นธีมสีวงนี้เวลาดูงานของวง"
                    >
                      + ธีมแอปวง
                    </button>
                  ))}
                {admin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => deleteGroup(g)}
                    aria-label="ลบวง"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {admin && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      ผู้ติดต่อวง:
                    </span>
                    <Input
                      value={g.contact_name ?? ""}
                      placeholder="ชื่อผู้ติดต่อ"
                      className="h-8 min-w-[140px] flex-1"
                      onChange={(e) =>
                        setGroupLocal(g.id, { contact_name: e.target.value })
                      }
                      onBlur={(e) =>
                        persistGroup(g.id, {
                          contact_name: e.target.value.trim() || null,
                        })
                      }
                    />
                    <Input
                      value={g.contact_phone ?? ""}
                      placeholder="เบอร์โทร"
                      className="h-8 min-w-[120px] flex-1 tabular-nums"
                      onChange={(e) =>
                        setGroupLocal(g.id, { contact_phone: e.target.value })
                      }
                      onBlur={(e) =>
                        persistGroup(g.id, {
                          contact_phone: e.target.value.trim() || null,
                        })
                      }
                    />
                  </div>
                )}
                {gm.length === 0 && (
                  <p className="py-2 text-center text-sm text-muted-foreground">
                    ยังไม่มีสมาชิก
                  </p>
                )}
                {gm.map((m) => (
                  <div key={m.id} className="flex flex-wrap items-center gap-2">
                    <Input
                      value={m.name}
                      disabled={!canEditRoster(g.id)}
                      placeholder="ชื่อ"
                      className="min-w-[120px] flex-1"
                      onChange={(e) => setMemberLocal(m.id, { name: e.target.value })}
                      onBlur={(e) => persistMember(m.id, { name: e.target.value })}
                    />
                    <Input
                      value={m.nickname ?? ""}
                      disabled={!canEditRoster(g.id)}
                      placeholder="ชื่อเล่น"
                      className="min-w-[100px] flex-1"
                      onChange={(e) =>
                        setMemberLocal(m.id, { nickname: e.target.value })
                      }
                      onBlur={(e) =>
                        persistMember(m.id, {
                          nickname: e.target.value.trim() || null,
                        })
                      }
                    />
                    <Input
                      type="number"
                      min={0}
                      value={m.mic_number ?? ""}
                      disabled={!canEditRoster(g.id)}
                      placeholder="ไมค์"
                      className="w-20 tabular-nums"
                      onChange={(e) =>
                        setMemberLocal(m.id, {
                          mic_number:
                            e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      onBlur={(e) =>
                        persistMember(m.id, {
                          mic_number:
                            e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                    <input
                      type="color"
                      value={m.color ?? "#7c3aed"}
                      disabled={!canEditRoster(g.id)}
                      onChange={(e) =>
                        setMemberLocal(m.id, { color: e.target.value })
                      }
                      onBlur={(e) =>
                        persistMember(m.id, { color: e.target.value })
                      }
                      className="h-9 w-9 shrink-0 cursor-pointer rounded border bg-transparent"
                      aria-label="สีสมาชิก"
                    />
                    {canEditRoster(g.id) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteMember(m.id)}
                        aria-label="ลบสมาชิก"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {canEditRoster(g.id) && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => addMember(g.id)}
                      className="mt-1"
                    >
                      <Plus className="h-4 w-4" /> เพิ่มสมาชิก
                    </Button>
                    <BulkAddMembers onAdd={(text) => bulkAddMembers(g.id, text)} />
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
