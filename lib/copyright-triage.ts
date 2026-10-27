// Copyright triage - อนุมัติ / ปฏิเสธ a song's rights - from the event page's panel and the
// Library's inline buttons. One write path for both, so they cannot drift.
//
// 2026-10-27 (hunt 8): both used to write `copyright_status` on the song id alone. An
// approver whose page was older than the row then overwrote whatever it held: another
// approver's ปฏิเสธ became อนุมัติ (and the band was told both), and a pending song whose
// file the Ar had replaced since was cleared on the strength of the OLD recording - 0047's
// back-to-review only fires for a song already cleared or rejected. The write now lands
// only on the song as this page showed it (status, title, file); anything else is
// re-read and said, like EventStatusActions does for a show.
//
// Not keyed on updated_at: the analysis columns, the cover and every other edit bump it,
// and the Library does not carry the stamp of its own writes back, so it would refuse
// triage after unrelated edits nobody needs to re-check.
import type { createClient } from "@/lib/supabase/client";
import { noRowsMessage, writeErrorText } from "@/lib/write-guard";
import { COPYRIGHT_META, type CopyrightStatus } from "@/lib/types";

type Client = ReturnType<typeof createClient>;

/** The songs guard (0018/0034/0053) speaks English - say it in Thai, and say what to do. */
export function friendlySongError(message?: string): string | undefined {
  if (!message) return message;
  if (message.includes("only an approver may change copyright_status"))
    return "สถานะลิขสิทธิ์ของเพลงนี้ถูกเปลี่ยนจากหน้าอื่นแล้ว — โหลดหน้านี้ใหม่แล้วลองอีกครั้ง (เปลี่ยนสถานะได้เฉพาะทีมค่าย/แอดมิน)";
  if (message.includes("only an editor may change song details"))
    return "แก้ข้อมูลเพลงได้เฉพาะแอดมิน/Ar ของวงนี้";
  // 0053: the band moved (on another device) and this file's key names the old band, or
  // a band move met a file attached elsewhere since this list loaded
  if (message.includes("song audio belongs to another band"))
    return "ไฟล์เสียงกับวงของเพลงนี้ไม่ตรงกัน (อาจมีคนย้ายวงหรือแนบไฟล์จากเครื่องอื่น) — โหลดหน้านี้ใหม่ ลบไฟล์เสียงก่อนย้ายวง แล้วอัปไฟล์ใหม่";
  return message;
}

/** The song as the page showed it. `audio_path` is compared only when the page has it
 *  (the event page's panel carries id, title and status only). */
export type TriageSong = {
  id: string;
  title: string;
  copyright_status: CopyrightStatus;
  audio_path?: string | null;
};

/** What the row holds now, for the page to show. */
export type TriageRow = Pick<TriageSong, "copyright_status" | "title"> & { audio_path?: string | null };

export type TriageOutcome =
  /** This write landed: tell the band. */
  | { kind: "done" }
  /** Already so, on the same song - another approver got there and told the band. */
  | { kind: "already" }
  /** The song moved on since the page loaded: nothing written; show `now`. */
  | { kind: "moved"; now: TriageRow; title: string; description: string }
  /** Refused or not sent: nothing written; put the old status back. */
  | { kind: "failed"; description: string | undefined };

const knownLabel = (s: CopyrightStatus) =>
  (COPYRIGHT_META[s] ?? COPYRIGHT_META.pending).label;

export async function setCopyrightStatus(
  supabase: Client,
  song: TriageSong,
  status: CopyrightStatus
): Promise<TriageOutcome> {
  const hasPath = song.audio_path !== undefined;
  let q = supabase
    .from("songs")
    .update({ copyright_status: status })
    .eq("id", song.id)
    .eq("copyright_status", song.copyright_status)
    .eq("title", song.title);
  if (hasPath) q = song.audio_path === null ? q.is("audio_path", null) : q.eq("audio_path", song.audio_path!);
  const { data, error } = await q.select("id");
  if (error) return { kind: "failed", description: friendlySongError(writeErrorText(error)) };
  if (Array.isArray(data) && data.length > 0) return { kind: "done" };

  // 0 rows, no error: the song moved on - or the write went out as anon / without the right.
  const { data: row } = await supabase
    .from("songs")
    .select("copyright_status, title, audio_path")
    .eq("id", song.id)
    .maybeSingle();
  const now = row as { copyright_status: CopyrightStatus; title: string; audio_path: string | null } | null;
  if (!now) return { kind: "failed", description: await noRowsMessage() };
  const sameSong = now.title === song.title && (!hasPath || now.audio_path === song.audio_path);
  if (sameSong && now.copyright_status === status) return { kind: "already" };
  if (!sameSong) {
    return {
      kind: "moved",
      now,
      title: "เพลงนี้ถูกแก้ไปแล้ว",
      description: "ชื่อเพลงหรือไฟล์เสียงเปลี่ยนตั้งแต่เปิดหน้านี้ — ตรวจเพลงอีกครั้งแล้วค่อยตัดสิน",
    };
  }
  if (now.copyright_status !== song.copyright_status) {
    return {
      kind: "moved",
      now,
      title: "สถานะลิขสิทธิ์ของเพลงนี้เปลี่ยนไปแล้ว",
      description: `ตอนนี้เป็น “${knownLabel(now.copyright_status)}” — ดูให้แน่ใจก่อนแล้วค่อยเปลี่ยนอีกครั้ง`,
    };
  }
  // the row is exactly what the page showed, and still nothing changed
  return { kind: "failed", description: await noRowsMessage() };
}
