"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Reassurance "save" bar — data already auto-saves on every edit; this button
 * just confirms with a toast and pulls fresh server data (router.refresh) WITHOUT
 * leaving the page. Mirrors the bottom action bar in the event workspace so the
 * Library / Groups pages feel the same.
 *
 * In flow at the end of the page, NOT sticky: the main's bottom padding
 * (var(--tabbar-h) + safe area, app/(app)/layout.tsx) is what keeps it clear of the
 * tab bar. A sticky bar would sit in the slot the Library's mini-player floats in
 * (8px above the tab bar) and the two would cover each other.
 */
export function ConfirmSavedBar({ note }: { note?: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  function confirmSaved() {
    setSaving(true);
    router.refresh();
    toast.success("บันทึกเรียบร้อยแล้ว");
    setTimeout(() => setSaving(false), 800);
  }

  return (
    <div className="no-print mt-2 flex flex-wrap items-center gap-2 rounded-[3px] bg-card p-3 shadow-edge">
      <Button
        type="button"
        variant="default"
        onClick={confirmSaved}
        disabled={saving}
        className="font-semibold"
      >
        <Check className="h-4 w-4" /> บันทึก / อัปเดต
      </Button>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
