"use client";

import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Check, ChevronUp, ChevronDown, Pencil, Phone, Plus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { StaffContact } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A `tel:` link for a typed phone number ("081-234 5678" → tel:0812345678), or
 *  null when there are not enough digits to dial. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 3 ? `tel:${digits}` : null;
}

/**
 * Label-wide crew directory (ช่างภาพ / ประสานงาน / …). Set once here; the Overview
 * "บันทึกเป็นรูป" export pulls these into its contact block automatically. Autosaves
 * each field on blur via RLS (admins + label staff). Each contact is a card with a
 * tap-to-call button; the pencil opens its fields.
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
  // The desktop app exposes its native bridge on window; the web never has it, so
  // the server render and the browser agree.
  const inDesktopApp = typeof window !== "undefined" && !!window.cueiqNative;
  const [rows, setRows] = useState<StaffContact[]>(initial);
  const [busy, setBusy] = useState(false);
  // Rows open for editing. A contact reads as a card with a call button; its
  // fields open on the pencil. A row that is still blank (and a row just added)
  // starts open, so there is something to type into.
  const [editing, setEditing] = useState<Set<string>>(
    () => new Set(initial.filter((r) => !r.name && !r.role && !r.phone).map((r) => r.id))
  );
  const setEditingRow = (id: string, on: boolean) =>
    setEditing((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  function setLocal(id: string, partial: Partial<StaffContact>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  }
  async function persist(id: string, partial: Partial<StaffContact>) {
    const { data, error } = await supabase
      .from("staff_contacts")
      .update(partial)
      .eq("id", id)
      .select("id");
    if (error) {
      toast.error("บันทึกไม่สำเร็จ", { description: error.message });
      return;
    }
    // No error and no row = the write reached the server and changed nothing (sent
    // anon after a failed token refresh, or the row is gone). This directory feeds
    // the printed run sheet's contact block. See lib/write-guard.ts.
    if (wroteNothing(data)) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
    }
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
    setEditingRow((data as StaffContact).id, true);
  }

  async function moveRow(id: string, dir: 1 | -1) {
    const snapshot = rows;
    const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((r) => r.id === id);
    const other = sorted[idx + dir];
    if (!other) return;
    const a = sorted[idx];
    // swap sort_order values
    setRows((prev) =>
      prev.map((r) => {
        if (r.id === a.id) return { ...r, sort_order: other.sort_order };
        if (r.id === other.id) return { ...r, sort_order: a.sort_order };
        return r;
      })
    );
    const results = await Promise.all([
      supabase.from("staff_contacts").update({ sort_order: other.sort_order }).eq("id", a.id).select("id"),
      supabase.from("staff_contacts").update({ sort_order: a.sort_order }).eq("id", other.id).select("id"),
    ]);
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      toast.error("สลับลำดับไม่สำเร็จ", { description: failed.error.message });
      setRows(snapshot);
      return;
    }
    // No error but zero rows on either write = sent anon after a failed token
    // refresh — the swap never reached the DB. See lib/write-guard.ts.
    if (results.some((r) => wroteNothing(r.data))) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
      setRows(snapshot);
    }
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

  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted-foreground">
          <span className="num text-[17px] text-foreground">{rows.length}</span> คน
        </span>
        <Button onClick={addRow} disabled={busy}>
          <Plus aria-hidden /> เพิ่มทีมงาน
        </Button>
      </div>
      {rows.length === 0 && (
        <p className="rounded-[2px] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          ยังไม่มีทีมงาน — กด “เพิ่มทีมงาน”
        </p>
      )}
      <ul className="stack">
        {sorted.map((r, i) => {
          if (editing.has(r.id)) {
            return (
              <li key={r.id} className="slab space-y-2 p-3">
                {/* fields: stacked full-width on phones, inline from sm up */}
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <Input
                    value={r.name}
                    placeholder="ชื่อ (เช่น พี่พัชร์)"
                    aria-label="ชื่อ"
                    className="w-full sm:min-w-[140px] sm:flex-1"
                    onChange={(e) => setLocal(r.id, { name: e.target.value })}
                    onBlur={(e) => persist(r.id, { name: e.target.value })}
                    onKeyDown={saveOnEnter}
                  />
                  <Input
                    value={r.role}
                    placeholder="หน้าที่ (เช่น ช่างภาพ)"
                    aria-label="หน้าที่"
                    className="w-full sm:min-w-[140px] sm:flex-1"
                    onChange={(e) => setLocal(r.id, { role: e.target.value })}
                    onBlur={(e) => persist(r.id, { role: e.target.value })}
                    onKeyDown={saveOnEnter}
                  />
                  <Input
                    value={r.phone}
                    type="tel"
                    inputMode="tel"
                    placeholder="เบอร์โทร"
                    aria-label="เบอร์โทร"
                    className="num w-full placeholder:font-sans placeholder:font-normal sm:min-w-[120px] sm:flex-1"
                    onChange={(e) => setLocal(r.id, { phone: e.target.value })}
                    onBlur={(e) => persist(r.id, { phone: e.target.value })}
                    onKeyDown={saveOnEnter}
                  />
                </div>
                <div className="flex items-center gap-1">
                  {/* up/down reorder */}
                  <Button
                    variant="ghost" size="icon"
                    disabled={i === 0}
                    onClick={() => moveRow(r.id, -1)}
                    aria-label="ขยับขึ้น"
                  >
                    <ChevronUp aria-hidden />
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    disabled={i === sorted.length - 1}
                    onClick={() => moveRow(r.id, 1)}
                    aria-label="ขยับลง"
                  >
                    <ChevronDown aria-hidden />
                  </Button>
                  <Button
                    variant="ghost" size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeRow(r.id)}
                    aria-label="ลบทีมงาน"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                  <Button variant="secondary" className="ml-auto" onClick={() => setEditingRow(r.id, false)}>
                    <Check aria-hidden /> เสร็จ
                  </Button>
                </div>
              </li>
            );
          }
          // No call button in the CueIQ Desktop app (desktop/src/pages/crew.tsx reuses
          // this): its will-navigate guard (desktop/electron/main.cjs) cancels every
          // navigation off the app's own URL, so a tel: link there is a button that does
          // nothing. The number stays on the card as text.
          const tel = inDesktopApp ? null : telHref(r.phone);
          return (
            <li key={r.id} className="slab flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className={cn("truncate text-[15px] font-semibold", !r.name && "text-muted-foreground")}>
                    {r.name || "ไม่มีชื่อ"}
                  </span>
                  {r.role && <span className="chip chip-neutral">{r.role}</span>}
                </div>
                {r.phone && <p className="num text-[16px] text-muted-foreground">{r.phone}</p>}
              </div>
              {tel && (
                <Button asChild variant="secondary" size="icon">
                  <a href={tel} aria-label={`โทรหา ${r.name || r.phone}`} title={`โทร ${r.phone}`}>
                    <Phone aria-hidden />
                  </a>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`แก้ไข ${r.name || "ทีมงาน"}`}
                title="แก้ไข"
                onClick={() => setEditingRow(r.id, true)}
              >
                <Pencil aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
