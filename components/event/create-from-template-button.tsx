"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutTemplate, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Row = Record<string, unknown>;

/** A band the user can create in, paired with that band's OWN demo-draft template. */
export type TemplateGroup = { id: string; name: string; templateId: string };

function strip(rows: Row[] | null, drop: string[], eventId: string): Row[] {
  return (rows ?? []).map((row) => {
    const o: Row = { ...row };
    for (const k of drop) delete o[k];
    o.event_id = eventId;
    return o;
  });
}

/**
 * "สร้างจากแม่แบบ" — clone a band's OWN demo-draft template ("Demo Draft Events",
 * is_template=true) into a new draft event for that same band. Each band has its
 * own template, so a clone never pulls another band's content. The schedule
 * skeleton + setlist (with song links + mic) are copied; audio bytes are never
 * copied. RLS limits this to a band the user can edit (the dropdown is already
 * scoped to the user's editable bands that have a template).
 */
export function CreateFromTemplateButton({ groups }: { groups: TemplateGroup[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [name, setName] = useState("");

  async function create() {
    const group = groups.find((g) => g.id === groupId);
    if (!group || busy) return;
    setBusy(true);
    const supabase = createClient();
    const templateId = group.templateId;
    try {
      const { data: tpl, error: tErr } = await supabase
        .from("events")
        .select("*")
        .eq("id", templateId)
        .single();
      if (tErr || !tpl) throw tErr ?? new Error("ไม่พบแม่แบบของวงนี้");

      const [sched, setl, mic] = await Promise.all([
        supabase.from("schedule_items").select("*").eq("event_id", templateId),
        supabase.from("setlist_items").select("*").eq("event_id", templateId),
        supabase.from("mic_assignments").select("*").eq("event_id", templateId),
      ]);

      const finalName = name.trim() || `${group.name} (จากแม่แบบ)`;

      const { data: created, error: insErr } = await supabase
        .from("events")
        .insert({
          tenant_id: tpl.tenant_id,
          group_id: groupId,
          name: finalName,
          event_type: tpl.event_type,
          venue: tpl.venue,
          show_start_time: tpl.show_start_time,
          hard_out_time: tpl.hard_out_time,
          notes: tpl.notes,
          map_url: tpl.map_url,
          costume_theme: tpl.costume_theme,
          status: "draft",
          event_date: null,
          is_template: false,
        })
        .select("id")
        .single();
      if (insErr || !created) throw insErr ?? new Error("สร้างงานไม่สำเร็จ");
      const nid = created.id as string;

      // schedule skeleton
      const schedRows = strip(sched.data as Row[] | null, ["id", "event_id"], nid);
      if (schedRows.length) {
        const { error } = await supabase.from("schedule_items").insert(schedRows);
        if (error) throw error;
      }
      // setlist — keep song links (same band), drop audio (re-uploaded per show)
      const setlRows = strip(
        setl.data as Row[] | null,
        ["id", "event_id", "audio_path", "audio_name"],
        nid
      );
      if (setlRows.length) {
        const { error } = await supabase.from("setlist_items").insert(setlRows);
        if (error) throw error;
      }
      // mic map (same band)
      const micRows = strip(mic.data as Row[] | null, ["id", "event_id", "created_at"], nid);
      if (micRows.length) {
        const { error } = await supabase.from("mic_assignments").insert(micRows);
        if (error) throw error;
      }

      toast.success("สร้างงานจากแม่แบบแล้ว — เปิดงานใหม่ให้");
      router.push(`/events/${nid}`);
    } catch (err) {
      toast.error("สร้างจากแม่แบบไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <LayoutTemplate className="h-4 w-4" /> สร้างจากแม่แบบ
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>สร้างงานจากแม่แบบ</DialogTitle>
            <DialogDescription>
              คัดลอกโครงงาน (คิว/เซ็ตลิสต์ตัวอย่าง) ของวงเป็นงานใหม่ (สถานะแบบร่าง ยังไม่กำหนดวันที่)
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>วง</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger>
                  <SelectValue placeholder="เลือกวง" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>ชื่องาน (เว้นว่างได้)</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="เช่น Live at ..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button onClick={create} disabled={busy || !groupId}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LayoutTemplate className="h-4 w-4" />}
              สร้างงาน
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
