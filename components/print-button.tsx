"use client";

import { Printer } from "lucide-react";

/**
 * Opens the browser print dialog (also "Save as PDF") for the current page.
 * Print styling lives in globals.css (@media print): light/ink-friendly, app-only
 * controls hidden via `.no-print`, rows kept from splitting across pages.
 */
export function PrintButton({ label = "พิมพ์ / บันทึก PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium shadow-sm transition hover:bg-muted"
    >
      <Printer className="h-4 w-4" /> {label}
    </button>
  );
}
