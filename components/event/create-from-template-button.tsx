"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LayoutTemplate, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
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

      // Each read can fail (network) or come back empty-with-no-error (the
      // ANON-fallback case — see lib/auth-session.ts). Either one used to sail
      // through Promise.all unnoticed: the event below got created anyway, and
      // the "clone" silently had nothing in it under a success toast. Check all
      // three BEFORE creating anything, so a bad read never produces a new event.
      const reads = [
        { label: "คิว", error: sched.error, rows: (sched.data as Row[] | null) ?? [] },
        { label: "เซ็ตลิสต์", error: setl.error, rows: (setl.data as Row[] | null) ?? [] },
        { label: "ผังไมค์", error: mic.error, rows: (mic.data as Row[] | null) ?? [] },
      ];
      const readErrors = reads.filter((r) => r.error);
      if (readErrors.length) {
        throw new Error(
          `โหลดข้อมูลแม่แบบไม่สำเร็จ (${readErrors.map((r) => r.label).join(", ")}) — ยังไม่ได้สร้างงานใหม่`
        );
      }
      // A demo-draft template exists specifically to be cloned into something
      // with content, so all three lists coming back empty at once is what an
      // anon-degraded read looks like, not what a real template looks like.
      // Only ask — a legitimately bare template is cheap and correct to accept.
      if (reads.every((r) => r.rows.length === 0) && !(await hasLiveSession())) {
        throw new Error(
          "เซสชันหมดอายุระหว่างโหลดแม่แบบ ยังไม่ได้สร้างงานใหม่ — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง"
        );
      }
      const [schedRead, setlRead, micRead] = reads;

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

      // From here the event row exists. A child insert failing partway must not
      // throw straight into the generic catch below — the user needs to know
      // exactly which part is missing from a real, already-created event, not a
      // one-line "something went wrong".
      const schedRows = strip(schedRead.rows, ["id", "event_id"], nid);
      const setlRows = strip(
        setlRead.rows,
        ["id", "event_id", "audio_path", "audio_name"], // audio re-uploaded per show
        nid
      );
      const micRows = strip(micRead.rows, ["id", "event_id", "created_at"], nid);

      const children: { table: string; label: string; rows: Row[] }[] = [
        { table: "schedule_items", label: "คิว", rows: schedRows },
        { table: "setlist_items", label: "เซ็ตลิสต์", rows: setlRows },
        { table: "mic_assignments", label: "ผังไมค์", rows: micRows },
      ];
      const attempted: { label: string; ok: boolean }[] = [];
      for (const child of children) {
        if (!child.rows.length) continue; // nothing to copy is not a failure
        const { error } = await supabase.from(child.table).insert(child.rows);
        attempted.push({ label: child.label, ok: !error });
      }
      const failed = attempted.filter((a) => !a.ok);

      if (failed.length === 0) {
        toast.success("สร้างงานจากแม่แบบแล้ว — เปิดงานใหม่ให้");
        router.push(`/events/${nid}`);
        return;
      }

      if (failed.length === attempted.length) {
        // Every part that had content to copy failed to copy — the new event has
        // NOTHING in it, i.e. it's not a partial clone, it's a ghost draft with
        // the template's name. Offer to remove it instead of leaving that behind.
        const remove = await confirm({
          title: "สร้างงานจากแม่แบบไม่สำเร็จ",
          description: `คัดลอกไม่สำเร็จทั้งหมด (${failed.map((f) => f.label).join(", ")}) งาน “${finalName}” ที่สร้างไว้จึงว่างเปล่า — ลบงานว่างนี้ทิ้งไหม?`,
          confirmText: "ลบงานว่างนี้",
          cancelText: "เก็บไว้",
        });
        if (remove) {
          const { data: delData, error: delErr } = await supabase
            .from("events")
            .delete()
            .eq("id", nid)
            .select("id");
          // 0 rows = the delete reached the server and removed nothing — RLS
          // mismatch or an anon-key fallback after the event insert's session
          // went stale, not a ghost that's actually gone. Must not tell the
          // user it's removed unless a row really left the table. See
          // lib/write-guard.ts.
          if (delErr || wroteNothing(delData)) {
            toast.error("สร้างงานไม่สำเร็จ และลบงานว่างไม่สำเร็จ", {
              description: delErr ? delErr.message : await noRowsMessage(),
            });
            router.push(`/events/${nid}`);
          } else {
            toast.error("สร้างงานจากแม่แบบไม่สำเร็จ — ลบงานว่างที่สร้างไว้แล้ว");
          }
        } else {
          toast.error("สร้างงานจากแม่แบบไม่สำเร็จ", {
            description: `สร้างงาน “${finalName}” ไว้แล้วแต่ยังไม่มีคิว/เซ็ตลิสต์/ผังไมค์ — เปิดงานแล้วสร้างเองได้`,
          });
          router.push(`/events/${nid}`);
        }
        setBusy(false);
        return;
      }

      // Some parts copied, some didn't — the event has real content, so it stays.
      // Say exactly what's missing rather than a generic failure toast.
      toast.error("สร้างงานจากแม่แบบสำเร็จบางส่วน", {
        description: `สร้างงาน “${finalName}” แล้ว แต่คัดลอกไม่สำเร็จ: ${failed.map((f) => f.label).join(", ")} — เปิดงานแล้วเพิ่มส่วนที่ขาดเองได้`,
      });
      router.push(`/events/${nid}`);
      setBusy(false);
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
