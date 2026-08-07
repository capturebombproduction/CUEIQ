"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RotateCw, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The exact sentence Next substitutes for a Server-Component throw in a
 * production build (verified against the shipped runtime,
 * node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js, Next
 * 15.5.22). Prefix-matched, not compared, so a future Next that appends to it
 * still matches.
 *
 * WHY (round 11). getEventBundle throws a carefully written Thai message naming
 * which part of the show could not be read ("อ่านข้อมูลงานไม่สำเร็จ (เซ็ตลิสต์)…").
 * None of it ever reaches a user: Next strips a server throw before it crosses the
 * client boundary, so what landed in the grey box below was this 40-odd-word
 * English paragraph. An Ar staring at a dead show page got a Thai heading followed
 * by English boilerplate and no idea whether their data was gone. The message is
 * not recoverable here — only the digest is — so say the true, useful thing in
 * Thai and show the digest, which is what matches the Vercel log line that
 * logBundleFailure wrote. */
const NEXT_REDACTED_PREFIX =
  "An error occurred in the Server Components render";

/**
 * Error boundary for the whole in-app area. Without it a render error (e.g. a
 * Safari-only throw) silently blanks the page under the nav — impossible to debug
 * from a phone. This catches it, shows the real message + a reload, and logs it to
 * the console so the cause is visible instead of a mystery blank.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Show a clearer message when the failure is just the network being down (e.g. a
  // soft nav that can't fetch its data) — the web app needs a connection now that
  // offline show-running lives in the CueIQ Desktop app.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(navigator.onLine === false);
    console.error("[CueIQ] in-app render error:", error);
  }, [error]);

  if (offline) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <CloudOff className="mx-auto h-10 w-10 text-amber-500" />
        <h1 className="text-xl font-bold">ออฟไลน์</h1>
        <p className="text-sm text-muted-foreground">
          ตอนนี้ไม่มีการเชื่อมต่อ จึงเปิดหน้านี้ไม่ได้ — เชื่อมต่ออินเทอร์เน็ตแล้วลองโหลดใหม่อีกครั้ง
        </p>
        <div className="flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>
            <RotateCw className="h-4 w-4" /> โหลดใหม่
          </Button>
        </div>
      </div>
    );
  }

  // A redacted server throw carries no usable message, only a digest. Don't print
  // Next's English boilerplate at a Thai-speaking user — tell them the one thing
  // they actually need to know (their data is intact, try again) and show the
  // digest so the cause can be looked up in the server log.
  //
  // Test ONLY the prefix. The first cut of this branch also treated an empty
  // `error.message` as "redacted", which it is not: a client-side throw carrying no
  // message has no digest either (digests are server-only), so it landed in the
  // redacted arm, blamed a server fetch for a browser bug, and told the user to send
  // a grey code that was not on screen — the box said "ไม่ทราบสาเหตุ".
  const redacted =
    typeof error.message === "string" &&
    error.message.startsWith(NEXT_REDACTED_PREFIX);
  const digestLine = error.digest ? `digest: ${error.digest}` : "";
  const details =
    (redacted
      ? digestLine
      : [error.message, digestLine].filter(Boolean).join("\n\n")) ||
    "ไม่ทราบสาเหตุ";
  // Only ask for the grey box when the grey box is worth sending.
  const hasClue = details !== "ไม่ทราบสาเหตุ";

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
      <h1 className="text-xl font-bold">หน้านี้มีปัญหา</h1>
      {/* Say only what the boundary can actually know. Next redacts EVERY server
          throw the same way — a statement timeout and a deterministic render bug
          arrive here identically — so the old copy's "เพราะดึงข้อมูลจากเซิร์ฟเวอร์ไม่ได้"
          was a guess at the cause. On a repeatable bug it read as a network blip and
          taught the user to keep pressing ลองใหม่ instead of telling anyone.
          "ข้อมูลยังอยู่ครบ" is safe to keep: this repo has no "use server" actions, so
          a redacted throw is always a render, never a half-finished write. */}
      <p className="text-sm text-muted-foreground">
        {redacted
          ? "เปิดหน้านี้ไม่สำเร็จ เซิร์ฟเวอร์ตอบกลับมาเป็นข้อผิดพลาด — ข้อมูลที่บันทึกไว้ยังอยู่ครบ ไม่มีอะไรหาย ลองใหม่อีกครั้ง"
          : "เกิดข้อผิดพลาดระหว่างแสดงผลหน้านี้ ลองโหลดใหม่อีกครั้ง"}
        {hasClue
          ? " ถ้ายังไม่หาย ส่งข้อความสีเทาด้านล่างนี้ให้ทีมพัฒนา (โจเซฟิน) จะได้ตามหาสาเหตุได้"
          : " ถ้ายังไม่หาย บอกทีมพัฒนา (โจเซฟิน) ว่ากำลังทำอะไรอยู่ตอนที่หน้านี้ขึ้น"}
      </p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
        {details}
      </pre>
      <div className="flex justify-center gap-2">
        <Button onClick={reset}>
          <RotateCw className="h-4 w-4" /> ลองใหม่
        </Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          โหลดหน้าใหม่
        </Button>
      </div>
    </div>
  );
}
