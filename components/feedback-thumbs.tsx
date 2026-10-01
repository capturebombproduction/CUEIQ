"use client";

import { useState, type MouseEvent } from "react";
import { FeedbackImage } from "@/components/feedback-image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The screenshots attached to one feedback report: 64 px thumbnails that open full
 * size in a sheet (spec §G.8 / §G.9). Shared by the Dev Inbox and "ที่ส่งไปแล้ว".
 *
 * Each thumbnail is a real <button>, so a keyboard opens it too. It reads the blob
 * URL FeedbackImage already made off its own <img> — no second fetch — and does
 * nothing while the picture is loading or when it could not be loaded (the
 * placeholder is not an image to enlarge). The thumbnail stays mounted under the
 * sheet, so that URL is not revoked while the sheet shows it.
 */
export function FeedbackThumbs({ keys }: { keys: string[] }) {
  const [src, setSrc] = useState<string | null>(null);

  function open(e: MouseEvent<HTMLButtonElement>) {
    const img = e.currentTarget.querySelector("img");
    if (img?.src) setSrc(img.src);
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={open}
            aria-label="ดูรูปขนาดเต็ม"
            className="rounded-[2px] transition-opacity duration-2 hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <FeedbackImage objectKey={k} className="h-16 w-16 cursor-zoom-in rounded-[2px]" />
          </button>
        ))}
      </div>
      <Dialog open={src !== null} onOpenChange={(o) => !o && setSrc(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Screenshot</DialogTitle>
            <DialogDescription className="sr-only">รูปที่แนบมากับฟีดแบค</DialogDescription>
          </DialogHeader>
          {src && (
            // A blob: URL from FeedbackImage's own presigned fetch — next/image cannot
            // take one, and this also runs in the Electron renderer.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt="รูปที่แนบมากับฟีดแบค"
              className="max-h-[70dvh] w-full rounded-[2px] bg-muted object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
