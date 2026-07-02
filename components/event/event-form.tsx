"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveEventWrite } from "@/lib/mgmt-write";
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
import { VENUE_PRESETS, findVenuePreset, mapsSearchUrl } from "@/lib/venues";

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
  const [mapUrl, setMapUrl] = useState(event?.map_url ?? "");
  const [costumeTheme, setCostumeTheme] = useState(event?.costume_theme ?? "");
  const [status, setStatus] = useState<GroupStatus>(event?.status ?? "draft");
  const [deadline, setDeadline] = useState(event?.deadline?.slice(0, 10) ?? "");
  const [deadlineNote, setDeadlineNote] = useState(event?.deadline_note ?? "");
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [loading, setLoading] = useState(false);

  function onVenueChange(v: string) {
    setVenue(v);
    // Auto-fill the map link from a known venue, unless the user already
    // pasted one of their own.
    const preset = findVenuePreset(v);
    if (preset && !mapUrl.trim()) setMapUrl(preset.mapUrl);
  }

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
      map_url: mapUrl.trim() || null,
      costume_theme: costumeTheme.trim() || null,
      deadline: deadline ? new Date(`${deadline}T23:59:00`).toISOString() : null,
      deadline_note: deadlineNote.trim() || null,
    };

    // saveEventWrite = the online write it always was; on the desktop it can also
    // queue the write when the network is down (web: unchanged, error surfaces).
    if (mode === "create") {
      const res = await saveEventWrite({ mode: "create", payload, createdBy: userId });
      setLoading(false);
      if (!res.ok) {
        toast.error("สร้างงานไม่สำเร็จ", { description: res.message });
        return;
      }
      if (res.queued) toast.success("ออฟไลน์อยู่ — สร้างงานไว้ในเครื่องแล้ว จะซิงค์ให้เมื่อเน็ตกลับ");
      else toast.success("สร้างงานสำเร็จ 🎉");
      router.push(`/events/${res.id}`);
      router.refresh();
    } else if (event) {
      const res = await saveEventWrite({
        mode: "edit",
        payload,
        eventId: event.id,
        baseUpdatedAt: event.updated_at,
      });
      setLoading(false);
      if (!res.ok) {
        toast.error("บันทึกไม่สำเร็จ", { description: res.message });
        return;
      }
      if (res.queued) toast.success("ออฟไลน์อยู่ — บันทึกไว้ในเครื่องแล้ว จะซิงค์ให้เมื่อเน็ตกลับ");
      else toast.success("บันทึกแล้ว");
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="venue">สถานที่</Label>
              <Input
                id="venue"
                list="venue-presets"
                value={venue}
                onChange={(e) => onVenueChange(e.target.value)}
                placeholder="เช่น Lot of Live (Bangkok)"
              />
              <datalist id="venue-presets">
                {VENUE_PRESETS.map((p) => (
                  <option key={p.name} value={p.name} />
                ))}
              </datalist>
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="map">Google Map (ลิงก์)</Label>
              <Input
                id="map"
                value={mapUrl}
                onChange={(e) => setMapUrl(e.target.value)}
                placeholder="วางลิงก์ Google Maps"
              />
              <p className="text-xs text-muted-foreground">
                {mapUrl.trim() ? (
                  <a
                    href={mapUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    เปิดลิงก์เพื่อตรวจสอบ ↗
                  </a>
                ) : venue.trim() ? (
                  <a
                    href={mapsSearchUrl(venue)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    ค้นหา “{venue}” ใน Google Maps แล้ววางลิงก์ ↗
                  </a>
                ) : (
                  "เลือกสถานที่ที่มี preset ระบบจะใส่ลิงก์ให้ หรือวางเอง"
                )}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="costume">COSTUME THEME</Label>
              <Input
                id="costume"
                value={costumeTheme}
                onChange={(e) => setCostumeTheme(e.target.value)}
                placeholder="เช่น All Black"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="deadline">เดดไลน์ (ส่งเซ็ตลิสต์)</Label>
              <Input
                id="deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="deadline_note">หมายเหตุเดดไลน์</Label>
              <Input
                id="deadline_note"
                value={deadlineNote}
                onChange={(e) => setDeadlineNote(e.target.value)}
                placeholder="เช่น ส่งให้ค่ายตรวจก่อน"
              />
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
