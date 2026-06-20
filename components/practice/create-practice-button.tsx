"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dumbbell, Loader2, Plus } from "lucide-react";
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

/**
 * "สร้างห้องซ้อม" — create a reusable practice room: a plain event flagged
 * is_practice=true for a chosen band. RLS (events_write = can_edit_group) limits
 * this to the band's Ar (or admin). Songs are added inside the room afterward.
 */
export function CreatePracticeButton({
  tenantId,
  userId,
  groups,
  label = "สร้างห้องซ้อม",
}: {
  tenantId: string;
  userId: string;
  groups: { id: string; name: string }[];
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [name, setName] = useState("");

  async function create() {
    if (!groupId || busy) return;
    setBusy(true);
    const supabase = createClient();
    try {
      const finalName =
        name.trim() ||
        `ซ้อม ${groups.find((g) => g.id === groupId)?.name ?? ""}`.trim();
      const { data: created, error } = await supabase
        .from("events")
        .insert({
          tenant_id: tenantId,
          group_id: groupId,
          name: finalName,
          is_practice: true,
          status: "draft",
          created_by: userId,
        })
        .select("id")
        .single();
      if (error || !created) throw error ?? new Error("สร้างห้องซ้อมไม่สำเร็จ");
      toast.success("สร้างห้องซ้อมแล้ว");
      router.push(`/events/${created.id as string}/practice`);
    } catch (err) {
      toast.error("สร้างห้องซ้อมไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> {label}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>สร้างห้องซ้อม</DialogTitle>
            <DialogDescription>
              ห้องซ้อมใช้ซ้ำได้เรื่อย ๆ — เพิ่มเพลงที่จะซ้อมเข้าไปในห้องได้ในหน้าซ้อม
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
              <Label>ชื่อห้องซ้อม (เว้นว่างได้)</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="เช่น ซ้อมประจำสัปดาห์ / เตรียมโชว์ ..."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button onClick={create} disabled={busy || !groupId}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Dumbbell className="h-4 w-4" />
              )}
              สร้าง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
