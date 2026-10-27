"use client";

import { useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { Mic, Plus, Trash2, Users } from "lucide-react";
import { BulkAddMembers } from "@/components/group/bulk-add-members";
import { createClient } from "@/lib/supabase/client";
import { removeEventAudio } from "@/lib/audio-remote";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { canEditGroup, groupRoleOf, isAdmin, type Perms } from "@/lib/permissions";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { Group, Member } from "@/lib/types";
import { bandLitVars, bandTriplet } from "@/lib/band-triplet";
import { cn } from "@/lib/utils";

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
  const confirm = useConfirm();
  const [groups, setGroups] = useState<Group[]>(initialGroups);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  // A refreshed roster from the page (the "บันทึก / อัปเดต" bar's router.refresh())
  // replaces the one on screen. It was read once at mount, so the bar promised the
  // latest data - a member another Ar added never appeared, and new sort orders were
  // worked out from the stale list (2026-10-27; the Library's twin, c4388cf).
  // Adopted when the CONTENT changed, each list on its own - not on a new array alone
  // (2026-10-27, hunt 3): the desktop Artists page handed in a fresh `bands` array on
  // every re-render (auth-js' SIGNED_IN on each return to the window, the hourly
  // TOKEN_REFRESHED), and each one put the roster back to the first fetch - a member
  // just added vanished, and since every field saves on blur, tabbing through wrote the
  // old name / mic number over the newer one. A page copy that only re-arrived equal
  // carries nothing newer than what is on screen.
  const [seenInitial, setSeenInitial] = useState(() => ({
    initialGroups,
    initialMembers,
    groupsKey: JSON.stringify(initialGroups),
    membersKey: JSON.stringify(initialMembers),
  }));
  if (initialGroups !== seenInitial.initialGroups || initialMembers !== seenInitial.initialMembers) {
    const groupsKey =
      initialGroups === seenInitial.initialGroups ? seenInitial.groupsKey : JSON.stringify(initialGroups);
    const membersKey =
      initialMembers === seenInitial.initialMembers ? seenInitial.membersKey : JSON.stringify(initialMembers);
    setSeenInitial({ initialGroups, initialMembers, groupsKey, membersKey });
    if (groupsKey !== seenInitial.groupsKey) setGroups(initialGroups);
    if (membersKey !== seenInitial.membersKey) setMembers(initialMembers);
  }
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  // Band name as the field had it when editing STARTED, per band. The input is
  // controlled by local state, so once the user clears it there is nothing left to
  // fall back to on blur — this is what an emptied name gets restored to.
  const nameAtFocus = useRef<Record<string, string>>({});

  // Create/delete a band + its settings (name/color/skin) = admin only.
  // Editing a band's roster (members) = admin OR that band's Artist Manager.
  const admin = isAdmin(perms);
  const canEditRoster = (groupId: string) => canEditGroup(perms, groupId);

  const membersOf = (gid: string) =>
    members
      .filter((m) => m.group_id === gid)
      .sort((a, b) => a.sort_order - b.sort_order);

  // ---- group operations ----------------------------------------------------
  // One band add at a time (2026-10-27, hunt 7): Enter in "ชื่อวงใหม่" called addGroup()
  // past the button's disabled={busy}, so a second Enter (or a held key repeating) while
  // the first insert was in flight created the band twice.
  const addingGroup = useRef(false);
  async function addGroup() {
    if (addingGroup.current) return;
    const name = newGroup.trim();
    if (!name) {
      toast.error("ใส่ชื่อวงก่อน");
      return;
    }
    addingGroup.current = true;
    setBusy(true);
    let res;
    try {
      res = await supabase
        .from("groups")
        .insert({ tenant_id: tenantId, name, color: "#7c3aed" })
        .select("*")
        .single();
    } finally {
      addingGroup.current = false;
      setBusy(false);
    }
    const { data, error } = res;
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
    const { data, error } = await supabase
      .from("groups")
      .update(partial)
      .eq("id", id)
      .select("id");
    if (error) {
      toast.error("บันทึกไม่สำเร็จ", { description: error.message });
      return;
    }
    // No error and no row = the write reached the server and changed nothing (sent
    // anon after a failed token refresh, or the row is gone). See lib/write-guard.ts.
    if (wroteNothing(data)) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
    }
  }

  async function deleteGroup(g: Group) {
    const ok = await confirm({
      title: `ลบวง “${g.name}”?`,
      description:
        "⚠️ จะลบสมาชิก เพลงในคลัง และงานทั้งหมดของวงนี้ด้วย — กู้คืนไม่ได้",
      confirmText: "ลบวง",
      requireTyped: g.name,
    });
    if (!ok) return;
    // Gather the R2 audio keys this delete will orphan BEFORE the DB cascade wipes
    // the rows: every library song's file + any legacy per-item file on the group's
    // events. (The cascade only removes DB rows, not the R2 objects.)
    // A read that FAILED is not "no files" (2026-10-27): going on would cascade the rows
    // away with their masters still on R2 - unreachable from then on (see below). Refuse,
    // before anything is touched, and let the delete be pressed again.
    const readFailed = (error: { message: string }) => {
      toast.error("ลบไม่สำเร็จ", {
        description: `อ่านรายการไฟล์เสียงของวงไม่สำเร็จ ยังไม่ได้ลบอะไร ลองใหม่อีกครั้ง (${error.message})`,
      });
    };
    const r2Keys = new Set<string>();
    const { data: songRows, error: songsErr } = await supabase
      .from("songs")
      .select("audio_path")
      .eq("group_id", g.id);
    if (songsErr) return readFailed(songsErr);
    (songRows ?? []).forEach((s) => s.audio_path && r2Keys.add(s.audio_path));
    const { data: evRows, error: evErr } = await supabase
      .from("events")
      .select("id")
      .eq("group_id", g.id);
    if (evErr) return readFailed(evErr);
    const evIds = (evRows ?? []).map((e) => e.id as string);
    if (evIds.length) {
      const { data: itemRows, error: itemsErr } = await supabase
        .from("setlist_items")
        .select("audio_path")
        .in("event_id", evIds)
        .not("audio_path", "is", null);
      if (itemsErr) return readFailed(itemsErr);
      (itemRows ?? []).forEach((i) => i.audio_path && r2Keys.add(i.audio_path));
    }

    const snapG = groups;
    const snapM = members;
    setGroups((prev) => prev.filter((x) => x.id !== g.id));
    setMembers((prev) => prev.filter((m) => m.group_id !== g.id));

    // Reclaim the R2 objects BEFORE the row is deleted, never after: /api/audio/presign
    // authorizes a delete with can_edit_group() on the key's group segment, and that
    // predicate reads the groups row — once the row is gone every delete 403s and the
    // masters (27–88 MB each) stay in the bucket forever, still counted by the Admin
    // storage gauge and unreachable (that route is the only delete path). Deleting a
    // key R2 no longer has is a no-op success, so an already-cleared file can't fail.
    const keys = [...r2Keys];
    let failed = 0;
    if (keys.length) {
      // Cap the wait: on venue Wi-Fi a stalled presign fetch must not hold the row
      // delete hostage (the row delete used to run first, so it always went through).
      // Anything still in flight when we give up counts as left behind — it will 403
      // the moment the row is gone anyway.
      const settled = await Promise.race([
        Promise.allSettled(keys.map((key) => removeEventAudio(key))),
        new Promise<null>((res) => setTimeout(() => res(null), 20_000)),
      ]);
      failed = settled
        ? settled.filter((r) => r.status === "rejected").length
        : keys.length;
    }

    // Asks for its row back (lib/write-guard.ts): sent as anon after a failed token
    // refresh, the delete matched no row with no error - the band vanished from the
    // screen and was back on the next load (2026-10-27).
    const { data: delRows, error } = await supabase.from("groups").delete().eq("id", g.id).select("id");
    if (error || wroteNothing(delRows)) {
      // Deleting the audio first means a failed row delete leaves the band alive with
      // its files already gone — say so, or the missing audio looks like a bug later.
      const why = error?.message ?? (await noRowsMessage());
      const gone = keys.length - failed;
      toast.error("ลบไม่สำเร็จ", {
        description: gone
          ? `${why} — แต่ไฟล์เสียงของวงถูกลบไปแล้ว ${gone} ไฟล์ ต้องอัปโหลดใหม่`
          : why,
      });
      setGroups(snapG);
      setMembers(snapM);
      return;
    }
    // The delete was type-confirmed and part of the audio is already gone, so a failed
    // cleanup must NOT block it — but don't swallow it either: whatever was left behind
    // keeps eating quota and can no longer be removed from inside the app.
    if (failed) {
      toast.warning(`ลบวงแล้ว แต่ลบไฟล์เสียงไม่สำเร็จ ${failed} ไฟล์`, {
        description: "ไฟล์ยังค้างกินพื้นที่อยู่บน R2 — ต้องลบจากคอนโซล Cloudflare เอง",
      });
    }
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

  /** True when the members were added - the dialog keeps the pasted roster otherwise. */
  async function bulkAddMembers(groupId: string, text: string): Promise<boolean> {
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return false;
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
      return false;
    }
    if (data.length === 0) {
      // no error and no row: the insert never landed (anon after a failed refresh)
      toast.error("เพิ่มสมาชิกไม่สำเร็จ", { description: await noRowsMessage() });
      return false;
    }
    setMembers((prev) => [...prev, ...(data as Member[])]);
    toast.success(`เพิ่ม ${data.length} คนแล้ว`);
    return true;
  }

  function setMemberLocal(id: string, partial: Partial<Member>) {
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...partial } : m))
    );
  }
  async function persistMember(id: string, partial: Partial<Member>) {
    const { data, error } = await supabase
      .from("members")
      .update(partial)
      .eq("id", id)
      .select("id");
    if (error) {
      toast.error("บันทึกไม่สำเร็จ", { description: error.message });
      return;
    }
    // No error and no row = the write reached the server and changed nothing (sent
    // anon after a failed token refresh, or the row is gone). See lib/write-guard.ts.
    if (wroteNothing(data)) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
    }
  }

  async function deleteMember(id: string) {
    const m = members.find((x) => x.id === id);
    // What else this delete takes (2026-10-27, hunt 7): event_members and
    // practice_attendance are ON DELETE CASCADE on members, so a member who graduated
    // vanished from the lineup of every show they ever played - past run sheets and the
    // share page included - and from the practice attendance history, under a prompt
    // that said only "จะถูกลบออกจากวง". Count first and say it, like the song delete
    // (song-library onDelete). A failed count is not "used nowhere": say so.
    const [shows, attendance] = await Promise.all([
      supabase.from("event_members").select("id", { count: "exact", head: true }).eq("member_id", id),
      supabase.from("practice_attendance").select("id", { count: "exact", head: true }).eq("member_id", id),
    ]).catch(() => [null, null] as const);
    const unknown = !shows || !attendance || !!shows.error || !!attendance.error;
    const showCount = unknown ? 0 : shows!.count ?? 0;
    const attendanceCount = unknown ? 0 : attendance!.count ?? 0;
    const who = m?.name ? `“${m.name}”` : "สมาชิกคนนี้";
    const lost = [
      showCount > 0 ? `ชื่อจะหายจากไลน์อัปของ ${showCount} งาน (รวมงานที่จบไปแล้ว)` : null,
      attendanceCount > 0 ? `ประวัติเช็คชื่อซ้อม ${attendanceCount} ครั้งจะหายด้วย` : null,
    ].filter(Boolean);
    const ok = await confirm({
      title: "ลบสมาชิกคนนี้?",
      description: unknown
        ? `${who} จะถูกลบออกจากวง — ตรวจไม่ได้ว่าอยู่ในไลน์อัปงานไหนบ้าง (เน็ตขัดข้อง) ถ้ามี ชื่อจะหายจากไลน์อัปงานพวกนั้นและประวัติเช็คชื่อซ้อมด้วย กู้คืนไม่ได้`
        : lost.length
          ? `${who} จะถูกลบออกจากวง — ${lost.join(" และ")} กู้คืนไม่ได้`
          : `${who} จะถูกลบออกจากวง`,
      ...(unknown || lost.length
        ? { confirmText: "ลบสมาชิก", requireTyped: m?.name?.trim() || "ลบ" }
        : {}),
    });
    if (!ok) return;
    const snap = members;
    setMembers((prev) => prev.filter((x) => x.id !== id));
    // Asks for its row back like the roster's other writes (lib/write-guard.ts): sent as
    // anon after a failed token refresh it deleted nobody, and the member was back on
    // the next load - and in the Lineup and the Mic Map (2026-10-27).
    const { data, error } = await supabase.from("members").delete().eq("id", id).select("id");
    if (error || wroteNothing(data)) {
      toast.error("ลบไม่สำเร็จ", { description: error?.message ?? (await noRowsMessage()) });
      setMembers(snap);
    }
  }

  // The viewer's own band is the screen's one lit hero, first in the list: the band
  // they hold a role in, or the only band they can see. An admin with no band of
  // their own gets no hero — every band reads the same.
  const ownId =
    groups.find((g) => groupRoleOf(perms, g.id) !== null)?.id ??
    (groups.length === 1 ? groups[0].id : null);
  const ordered = ownId
    ? [...groups.filter((g) => g.id === ownId), ...groups.filter((g) => g.id !== ownId)]
    : groups;

  return (
    <div className="space-y-4">
      {admin && (
        <div className="flex gap-2 sm:max-w-md">
          <Input
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
            }}
            placeholder="ชื่อวงใหม่ (เช่น Seishin Kakumei)"
            aria-label="ชื่อวงใหม่"
            className="min-w-0 flex-1"
          />
          <Button onClick={addGroup} disabled={busy} className="shrink-0">
            <Plus aria-hidden /> เพิ่มวง
          </Button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[2px] border border-dashed border-border py-16 text-center">
          <Users className="h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="text-muted-foreground">ยังไม่มีวง</p>
        </div>
      ) : (
        <div className="space-y-3">
          {ordered.map((g) => {
            const gm = membersOf(g.id);
            const hero = g.id === ownId;
            const editable = canEditRoster(g.id);
            return (
              <section
                key={g.id}
                aria-label={g.name}
                data-band-hero={hero || undefined}
                className={cn(hero ? "lit cut sweep [--cut:20px]" : "slab", "space-y-4 p-4")}
                // --lit keys the edge in this band's colour; --lit-g makes the glow its
                // capped stage light (v3 §E.11), not the raw colour --lit alone glows in
                style={hero ? (bandLitVars(g.color) as CSSProperties) : undefined}
              >
                {/* Identity: colour square + name + head count. */}
                <div className="flex flex-wrap items-center gap-3">
                  {admin ? (
                    <input
                      type="color"
                      value={g.color ?? "#7c3aed"}
                      onChange={(e) => setGroupLocal(g.id, { color: e.target.value })}
                      onBlur={(e) => persistGroup(g.id, { color: e.target.value })}
                      className={SWATCH}
                      aria-label="สีวง"
                      title="สีวง"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="h-7 w-7 shrink-0 rounded-[2px]"
                      style={{ background: `hsl(${bandTriplet(g.color)})` }}
                    />
                  )}
                  {admin ? (
                    <Input
                      value={g.name}
                      onChange={(e) => setGroupLocal(g.id, { name: e.target.value })}
                      onFocus={() => {
                        nameAtFocus.current[g.id] = g.name;
                      }}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        // `g.name` is ALREADY the edited (emptied) value by the time blur
                        // fires, so the old `|| g.name` fallback was '' || '' — clearing the
                        // field saved an empty name and the band went blank everywhere
                        // (Overview, export, event list, band dropdowns) with no way to tell
                        // which row is which. Put the name back instead of persisting it.
                        if (!name) {
                          setGroupLocal(g.id, { name: nameAtFocus.current[g.id] ?? g.name });
                          toast.error("ชื่อวงว่างไม่ได้ — คืนชื่อเดิมให้แล้ว");
                          return;
                        }
                        persistGroup(g.id, { name });
                      }}
                      aria-label="ชื่อวง"
                      className="min-w-0 flex-1 text-[17px] font-semibold sm:max-w-xs sm:text-[17px]"
                    />
                  ) : (
                    <h2 className="disp min-w-0 flex-1 break-words text-[22px] leading-tight">{g.name}</h2>
                  )}
                  <Badge variant="secondary">
                    <Users aria-hidden />
                    <span className="num text-[14px]">{gm.length}</span> คน
                  </Badge>
                </div>

                {admin && (
                  <div className="space-y-2 rounded-[2px] bg-muted p-3">
                    {/* The app-wide skin while viewing this band's shows. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-muted-foreground">ธีมแอป</span>
                      {g.skin ? (
                        <>
                          <input
                            type="color"
                            value={g.skin}
                            onChange={(e) => setGroupLocal(g.id, { skin: e.target.value })}
                            onBlur={(e) => persistGroup(g.id, { skin: e.target.value })}
                            className={SWATCH}
                            aria-label="สีธีมทั้งแอปของวง"
                            title="สีธีมทั้งแอปเวลาดูงานของวงนี้"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-11 min-w-11 [@media(pointer:fine)]:h-9"
                            onClick={() => {
                              setGroupLocal(g.id, { skin: null });
                              persistGroup(g.id, { skin: null });
                            }}
                          >
                            ปิด
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-11 [@media(pointer:fine)]:h-9"
                          onClick={() => {
                            const hex = g.color ?? "#7c3aed";
                            setGroupLocal(g.id, { skin: hex });
                            persistGroup(g.id, { skin: hex });
                          }}
                          title="ทำให้ทั้งแอปเป็นธีมสีวงนี้เวลาดูงานของวง"
                        >
                          <Plus aria-hidden /> ธีมแอปวง
                        </Button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-muted-foreground">
                        ผู้ติดต่อวง:
                      </span>
                      <Input
                        value={g.contact_name ?? ""}
                        placeholder="ชื่อผู้ติดต่อ"
                        aria-label="ชื่อผู้ติดต่อวง"
                        className="min-w-[140px] flex-1"
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
                        type="tel"
                        inputMode="tel"
                        placeholder="เบอร์โทร"
                        aria-label="เบอร์โทรผู้ติดต่อวง"
                        className="num min-w-[120px] flex-1 placeholder:font-sans placeholder:font-normal"
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
                  </div>
                )}

                {gm.length === 0 && (
                  <p className="py-2 text-center text-sm text-muted-foreground">
                    ยังไม่มีสมาชิก
                  </p>
                )}

                {editable ? (
                  // Roster editor: one row per member, every field saves on blur.
                  gm.length > 0 && (
                    <ul className="stack">
                      {gm.map((m) => (
                        <li
                          key={m.id}
                          className="grid grid-cols-[minmax(0,1fr)_5.5rem_2.75rem_2.75rem] items-center gap-2 rounded-[2px] bg-muted p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5.5rem_2.75rem_2.75rem]"
                        >
                          <Input
                            value={m.name}
                            placeholder="ชื่อ"
                            aria-label="ชื่อ"
                            className="col-span-4 sm:col-span-1"
                            onChange={(e) => setMemberLocal(m.id, { name: e.target.value })}
                            onBlur={(e) => persistMember(m.id, { name: e.target.value })}
                          />
                          <Input
                            value={m.nickname ?? ""}
                            placeholder="ชื่อเล่น"
                            aria-label="ชื่อเล่น"
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
                            placeholder="ไมค์"
                            aria-label="เบอร์ไมค์"
                            className="num placeholder:font-sans placeholder:font-normal"
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
                            onChange={(e) =>
                              setMemberLocal(m.id, { color: e.target.value })
                            }
                            onBlur={(e) =>
                              persistMember(m.id, { color: e.target.value })
                            }
                            className={SWATCH}
                            aria-label="สีสมาชิก"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteMember(m.id)}
                            aria-label="ลบสมาชิก"
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  // Read-only: the roster as people, not as disabled form fields.
                  gm.length > 0 && (
                    <ul className="grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4" aria-label="สมาชิก">
                      {gm.map((m) => (
                        <MemberTile key={m.id} m={m} />
                      ))}
                    </ul>
                  )
                )}

                {(editable || admin) && (
                  <div className="flex flex-wrap items-center gap-2">
                    {editable && (
                      <>
                        <Button variant="secondary" onClick={() => addMember(g.id)}>
                          <Plus aria-hidden /> เพิ่มสมาชิก
                        </Button>
                        <BulkAddMembers onAdd={(text) => bulkAddMembers(g.id, text)} />
                      </>
                    )}
                    {admin && (
                      <Button
                        variant="destructive-outline"
                        className="ml-auto"
                        onClick={() => deleteGroup(g)}
                      >
                        <Trash2 aria-hidden /> ลบวง
                      </Button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A native colour input drawn as a plain 44 px swatch (no browser chrome). */
const SWATCH =
  "h-11 w-11 shrink-0 cursor-pointer rounded-[2px] border-0 bg-transparent p-0 shadow-edge [&::-moz-color-swatch]:rounded-[2px] [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[2px] [&::-webkit-color-swatch]:border-0";

/** A Thai name's first letter, keeping a leading vowel with its consonant ("เช"). */
function initialOf(label: string): string {
  const chars = Array.from(label.trim());
  if (!chars.length) return "?";
  return /^[เแโใไ]$/.test(chars[0]) && chars[1] ? chars[0] + chars[1] : chars[0].toUpperCase();
}

/** One member in the read-only roster: a ring in their colour, nickname, mic. */
function MemberTile({ m }: { m: Member }) {
  const label = m.nickname?.trim() || m.name.trim() || "—";
  const ring = m.color ? `hsl(${bandTriplet(m.color)})` : "hsl(var(--border))";
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-[2px] bg-muted p-3">
      <span
        aria-hidden
        className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-card text-[17px] font-semibold"
        style={{ boxShadow: `0 0 0 3px ${ring}` }}
      >
        {initialOf(label)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-tight">{label}</p>
        {m.nickname && m.name && m.name.trim() !== label && (
          <p className="truncate text-[12.5px] text-muted-foreground">{m.name}</p>
        )}
        <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-muted-foreground">
          <Mic className="h-3.5 w-3.5" aria-hidden />
          {m.mic_number != null ? (
            <span className="num text-[15px] text-foreground">{m.mic_number}</span>
          ) : (
            "ไม่มีไมค์"
          )}
        </p>
      </div>
    </li>
  );
}
