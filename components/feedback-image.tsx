"use client";

import { useEffect, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { fetchImageBlob } from "@/lib/audio-remote";
import { cn } from "@/lib/utils";

/**
 * One screenshot attached to a feedback report, addressed by its R2 object key.
 *
 * Fetched through the presign route rather than pointed at with a plain <img src>:
 * a presigned URL is valid for 15 minutes, and the Dev Inbox is exactly the kind of
 * tab someone leaves open all afternoon. Going through lib/audio-remote also means
 * the desktop app gets the bytes through the Electron main process, which is the
 * only way they arrive at all under file:// (CORS).
 *
 * A key whose object is missing renders as a labelled placeholder, never a broken
 * image box: the row lists the keys the author INTENDED to attach, and an upload
 * that failed after the row was written is a real state, not a bug to hide.
 */
export function FeedbackImage({
  objectKey,
  className,
  onClick,
}: {
  objectKey: string;
  className?: string;
  onClick?: (url: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    fetchImageBlob(objectKey)
      .then((blob) => {
        if (revoked) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {
        if (!revoked) setFailed(true);
      });
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [objectKey]);

  if (failed) {
    return (
      <div
        data-testid="feedback-image-missing"
        className={cn(
          "flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[10px] text-muted-foreground",
          className
        )}
      >
        <ImageOff className="h-4 w-4" />
        โหลดรูปไม่ได้
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={cn(
          "flex h-20 w-20 shrink-0 items-center justify-center rounded-md border bg-muted/40",
          className
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // A blob: URL from our own presigned fetch — next/image cannot take one, and
    // this file also runs in the Electron renderer where next/image does not exist.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="รูปที่แนบมากับฟีดแบค"
      data-testid="feedback-image"
      onClick={onClick ? () => onClick(url) : undefined}
      className={cn(
        "h-20 w-20 shrink-0 rounded-md border object-cover",
        onClick && "cursor-zoom-in",
        className
      )}
    />
  );
}
