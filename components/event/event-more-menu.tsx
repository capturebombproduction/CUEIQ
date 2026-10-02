"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * What an action in the sheet must remember after the sheet closes.
 *
 * The sheet's contents UNMOUNT on close (components/ui/dialog.tsx renders the
 * content in a portal with no forceMount — and forceMount is not an option: a modal
 * Radix dialog aria-hides the rest of the page from the moment its content mounts).
 * So an action that keeps state of its own — the share link it just created or
 * revoked — would come back on the next open seeded from the PAGE-LOAD props. For
 * the share link that was dangerous, not untidy: "สร้างลิงก์แชร์" offered again
 * after a link had been made, and pressing it replaced the link the venue already
 * had. This map lives in the menu, which stays mounted with the hero, so it lasts
 * exactly as long as this page does. Outside a menu the hook returns null, and the
 * action falls back to its own state alone.
 */
const SheetMemory = createContext<Map<string, unknown> | null>(null);

export function useSheetMemory(): Map<string, unknown> | null {
  return useContext(SheetMemory);
}

/**
 * The event hero's `⋯` (spec §G.3): the show's rarer actions in one sheet (a
 * bottom sheet on a phone, a panel from sm), so the hero keeps ONE row.
 *
 * `children` are the action controls themselves — Edit details, Share link,
 * Export Excel, reload — each a Button (or a component that renders one), stacked
 * as 54 px rows. Share opens its own dialog on top of this one; Radix stacks the
 * two, and the sheet is still here when that one closes.
 */
export function EventMoreMenu({
  eventName,
  children,
}: {
  eventName?: string | null;
  children: ReactNode;
}) {
  const [memory] = useState(() => new Map<string, unknown>());
  return (
    <SheetMemory.Provider value={memory}>
      <Dialog>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="shrink-0"
            aria-label="More actions"
            title="เพิ่มเติม — แก้ไข แชร์ ส่งออก"
          >
            <MoreHorizontal aria-hidden className="h-5 w-5" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader className="min-w-0">
            <DialogTitle>More</DialogTitle>
            <DialogDescription className="truncate">
              {eventName ? `${eventName} — ` : ""}แก้ไข แชร์ และส่งออก
            </DialogDescription>
          </DialogHeader>
          <div className="stack [&>*]:h-[54px] [&>*]:w-full [&>*]:justify-start [&>*]:rounded-[2px] [&>*]:px-4">
            {children}
          </div>
        </DialogContent>
      </Dialog>
    </SheetMemory.Provider>
  );
}
