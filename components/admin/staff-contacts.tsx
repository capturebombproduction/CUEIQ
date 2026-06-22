"use client";

import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { StaffContact } from "@/lib/types";

/**
 * Label-wide crew directory (ช่างภาพ / ประสานงาน / …). Set once here; the Overview
 * "บันทึกเป็นรูป" export pulls these into its contact block automatically. Autosaves
 * each field on blur via RLS (admins only).
 */
export function StaffContactsManager({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: StaffContact[];
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  const [rows, setRows] = useState<StaffContact[]>(initial);
  const [busy, setBusy] = useState(false);

  function setLocal(id: string, partial: Partial<StaffContact>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  }
  async function persist(id: string, partial: Partial<StaffContact>) {
    const { error } = await supabase
      .from("staff_contacts")
      .update(partial)
      .eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
  }
  // Enter saves the field (it blurs, firing the onBlur persist) so a typed value
  // never hangs unsaved if the admin leaves the page without clicking away.
  function saveOnEnter(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") e.currentTarget.blur();
  }

  async function addRow() {
    setBusy(true);
    const sort = rows.length ? Math.max(...rows.map((r) => r.sort_order)) + 1 : 1;
    const { data, error } = await supabase
      .from("staff_contacts")
      .insert({ tenant_id: tenantId, name: "", role: "", phone: "", sort_order: sort })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error("เพิ่มไม่สำเร็จ", { description: error?.message });
      return;
    }
    setRows((prev) => [...prev, data as StaffContact]);
  }

  async function removeRow(id: string) {
    const row = rows.find((r) => r.id === id);
    const ok = await confirm({
      title: "ลบทีมงานคนนี้?",
      description: row?.name ? `“${row.name}” จะถูกลบออกจากรายชื่อ` : "แถวนี้จะถูกลบออก",
    });
    if (!ok) return;
    const snap = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    const { error } = await supabase.from("staff_contacts").delete().eq("id", id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setRows(snap);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" /> ทีมงานประจำค่าย (สำหรับตารางงาน)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          ชื่อ · หน้าที่ · เบอร์ ของทีมงานประจำ (ช่างภาพ / ประสานงาน …) — ระบบจะใส่ลงในรูป
          “บันทึกเป็นรูป” ของหน้า Overview ให้อัตโนมัติทุกงาน
        </p>
        {rows.length === 0 && (
          <p className="py-2 text-center text-sm text-muted-foreground">
            ยังไม่มีทีมงาน — กด “เพิ่มทีมงาน”
          </p>
        )}
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2">
            <Input
              value={r.name}
              placeholder="ชื่อ (เช่น พี่พัชร์)"
              className="min-w-[140px] flex-1"
              onChange={(e) => setLocal(r.id, { name: e.target.value })}
              onBlur={(e) => persist(r.id, { name: e.target.value })}
              onKeyDown={saveOnEnter}
            />
            <Input
              value={r.role}
              placeholder="หน้าที่ (เช่น ช่างภาพ)"
              className="min-w-[140px] flex-1"
              onChange={(e) => setLocal(r.id, { role: e.target.value })}
              onBlur={(e) => persist(r.id, { role: e.target.value })}
              onKeyDown={saveOnEnter}
            />
            <Input
              value={r.phone}
              placeholder="เบอร์โทร"
              className="min-w-[120px] flex-1 tabular-nums"
              onChange={(e) => setLocal(r.id, { phone: e.target.value })}
              onBlur={(e) => persist(r.id, { phone: e.target.value })}
              onKeyDown={saveOnEnter}
            />
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive"
              onClick={() => removeRow(r.id)}
              aria-label="ลบทีมงาน"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={addRow}
          disabled={busy}
          className="mt-1"
        >
          <Plus className="h-4 w-4" /> เพิ่มทีมงาน
        </Button>
      </CardContent>
    </Card>
  );
}
