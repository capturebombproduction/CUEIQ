"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EVENT_TYPES,
  STATUS_META,
  type EventRow,
  type EventType,
  type Group,
  type GroupStatus,
} from "@/lib/types";
import { shortClock } from "@/lib/time";

const EVENT_TYPE_KEYS = Object.keys(EVENT_TYPES) as EventType[];
const STATUS_KEYS = Object.keys(STATUS_META) as GroupStatus[];

export function EventForm({
  mode,
  tenantId,
  userId,
  groups,
  defaultGroupId,
  event,
}: {
  mode: "create" | "edit";
  tenantId: string;
  userId?: string;
  groups: Group[];
  defaultGroupId?: string;
  event?: EventRow;
}) {
  const router = useRouter();
  const [name, setName] = useState(event?.name ?? "");
  const [groupId, setGroupId] = useState(
    event?.group_id ?? defaultGroupId ?? groups[0]?.id ?? ""
  );
  const [eventType, setEventType] = useState<EventType>(
    event?.event_type ?? "idol"
  );
  const [eventDate, setEventDate] = useState(event?.event_date ?? "");
  const [showStart, setShowStart] = useState(shortClock(event?.show_start_time));
  const [hardOut, setHardOut] = useState(shortClock(event?.hard_out_time));
  const [venue, setVenue] = useState(event?.venue ?? "");
  const [status, setStatus] = useState<GroupStatus>(event?.status ?? "draft");
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("กรุณาใส่ชื่องาน");
      return;
    }
    if (!groupId) {
      toast.error("กรุณาเลือกวง");
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const payload = {
      tenant_id: tenantId,
      group_id: groupId,
      name: name.trim(),
      event_date: eventDate || null,
      venue: venue.trim() || null,
      event_type: eventType,
      show_start_time: showStart || null,
      hard_out_time: hardOut || null,
      status,
      notes: notes.trim() || null,
    };

    if (mode === "create") {
      const { data, error } = await supabase
        .from("events")
        .insert({ ...payload, created_by: userId })
        .select("id")
        .single();
      setLoading(false);
      if (error || !data) {
        toast.error("สร้างงานไม่สำเร็จ", { description: error?.message });
        return;
      }
      toast.success("สร้างงานสำเร็จ 🎉");
      router.push(`/events/${data.id}`);
      router.refresh();
    } else if (event) {
      const { error } = await supabase
        .from("events")
        .update(payload)
        .eq("id", event.id);
      setLoading(false);
      if (error) {
        toast.error("บันทึกไม่สำเร็จ", { description: error.message });
        return;
      }
      toast.success("บันทึกแล้ว");
      router.push(`/events/${event.id}`);
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === "create" ? "ข้อมูลงาน" : "แก้ไขข้อมูลงาน"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">ชื่องาน *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น VANTAFLARE SUNNY SEITAN-SAI"
              required
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
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
            <div className="space-y-2">
              <Label>ประเภทงาน</Label>
              <Select
                value={eventType}
                onValueChange={(v) => setEventType(v as EventType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPE_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {EVENT_TYPES[k].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="date">วันที่</Label>
              <Input
                id="date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="start">เวลาเริ่มโชว์</Label>
              <Input
                id="start"
                type="time"
                value={showStart}
                onChange={(e) => setShowStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hardout">Hard Out (เวลาต้องจบ)</Label>
              <Input
                id="hardout"
                type="time"
                value={hardOut}
                onChange={(e) => setHardOut(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="venue">สถานที่</Label>
              <Input
                id="venue"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="เช่น Lot of Live (Bangkok)"
              />
            </div>
            <div className="space-y-2">
              <Label>สถานะ</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as GroupStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {STATUS_META[k].emoji} {STATUS_META[k].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">โน้ต</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="รายละเอียดเพิ่มเติม"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
            >
              ยกเลิก
            </Button>
            <Button type="submit" disabled={loading}>
              {loading
                ? "กำลังบันทึก…"
                : mode === "create"
                  ? "สร้างงาน"
                  : "บันทึก"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
