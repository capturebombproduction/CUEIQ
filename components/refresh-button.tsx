"use client";

import { useState } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Hard-reloads the page to re-fetch fresh data from the server.
 *
 * Needed because the tabbed editors keep their own local state; after adding /
 * editing items and switching tabs, a read view can show stale data until the
 * page is reloaded. This button makes that explicit so users aren't confused.
 */
export function RefreshButton({
  label = "อัปเดต",
  variant = "outline",
  className,
}: {
  label?: string;
  variant?: "outline" | "secondary" | "default";
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        window.location.reload();
      }}
      title="โหลดข้อมูลล่าสุด"
    >
      <RotateCw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
      {label}
    </Button>
  );
}
