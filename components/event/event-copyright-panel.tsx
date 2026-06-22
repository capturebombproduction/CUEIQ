"use client";

import { useState } from "react";
import { ShieldCheck, Check, Ban } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { COPYRIGHT_META, type CopyrightStatus } from "@/lib/types";

export type CopyrightSong = {
  id: string;
  title: string;
  copyright_status: CopyrightStatus;
};

/**
 * Approver-only (admin / label_staff) copyright triage for the library songs used
 * in THIS event's setlist — so staff can clear/reject right where they proof the
 * show, without opening the full song library (which label_staff no longer sees).
 * Mirrors the library's update: optimistic + the same RLS-guarded songs UPDATE +
 * notify the band. Render only when the viewer canApprove (the page gates it).
 */
export function EventCopyrightPanel({
  songs: initial,
}: {
  songs: CopyrightSong[];
}) {
  const supabase = createClient();
  const [songs, setSongs] = useState(initial);

  if (songs.length === 0) return null;

  async function setStatus(song: CopyrightSong, status: CopyrightStatus) {
    if (status === song.copyright_status) return;
    setSongs((prev) =>
      prev.map((s) => (s.id === song.id ? { ...s, copyright_status: status } : s))
    );
    const { error } = await supabase
      .from("songs")
      .update({ copyright_status: status })
      .eq("id", song.id);
    if (error) {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", { description: error.message });
      setSongs((prev) =>
        prev.map((s) =>
          s.id === song.id ? { ...s, copyright_status: song.copyright_status } : s
        )
      );
      return;
    }
    if (status === "rejected") notify("song_rejected", { songId: song.id });
    else if (status === "cleared") notify("song_cleared", { songId: song.id });
  }

  return (
    <section className="no-print rounded-lg border bg-card p-4">
      <h2 className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-primary" /> ลิขสิทธิ์เพลงในงานนี้
        <span className="font-normal text-muted-foreground">
          · ตรวจ/อนุมัติได้ที่นี่ (เฉพาะเพลงจากคลังที่ใช้ในงาน)
        </span>
      </h2>
      <ul className="mt-3 divide-y">
        {songs.map((song) => {
          const cr = COPYRIGHT_META[song.copyright_status];
          return (
            <li
              key={song.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {song.title}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={cr.variant}>
                  {cr.emoji} {cr.label}
                </Badge>
                {song.copyright_status !== "cleared" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setStatus(song, "cleared")}
                  >
                    <Check className="h-4 w-4" /> อนุมัติ
                  </Button>
                )}
                {song.copyright_status !== "rejected" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setStatus(song, "rejected")}
                  >
                    <Ban className="h-4 w-4" /> ปฏิเสธ
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
