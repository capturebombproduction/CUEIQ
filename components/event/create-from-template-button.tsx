"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutTemplate, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { cloneEvent } from "@/lib/clone-event";
import { reportClone } from "@/components/event/clone-outcome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";
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

/** A band the user can create in, paired with that band's OWN demo-draft template. */
export type TemplateGroup = { id: string; name: string; templateId: string };

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
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [name, setName] = useState("");

  async function create() {
    const group = groups.find((g) => g.id === groupId);
    if (!group || busy) return;
    setBusy(true);
    const supabase = createClient();
    const finalName = name.trim() || `${group.name} (จากแม่แบบ)`;
    try {
      // Reads everything first and creates nothing if a read fails — see
      // lib/clone-event.ts, which this and "ก๊อปงาน" now share.
      const result = await cloneEvent(supabase, {
        sourceId: group.templateId,
        sourceLabel: "แม่แบบของวงนี้",
        buildEvent: (tpl) => ({
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
        }),
      });
      const opened = await reportClone(result, {
        name: finalName,
        supabase,
        confirm,
        open: (id) => router.push(`/events/${id}`),
        text: {
          success: "สร้างงานจากแม่แบบแล้ว — เปิดงานใหม่ให้",
          failed: "สร้างงานจากแม่แบบไม่สำเร็จ",
          partial: "สร้างงานจากแม่แบบสำเร็จบางส่วน",
        },
      });
      if (!opened) setBusy(false);
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
