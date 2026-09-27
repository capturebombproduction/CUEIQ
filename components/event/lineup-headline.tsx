import { lineupStatus, memberLabel } from "@/lib/lineup";

// "รูปจากในแอฟมีการแสดงคนขาด แต่ตอนภาพสรุปไม่ได้แจ้งว่าครมาบ้างมีคนขาดไหม"
// (in-app feedback, 2026-09-11). The members block used to say it with a faded
// strike-through alone, and was left out of the JPG altogether. The image is the
// sheet that travels, so who is missing is written out in words — a struck-out
// badge is easy to miss on a phone photo of a phone screenshot.
//
// No hooks and no "use client": the event summary (client) and the public share
// page (server) both render this, so the wording lives in one place.
export function LineupHeadline({
  members,
  lineup,
}: {
  members: { id: string; name: string; nickname: string | null }[];
  lineup: string[];
}) {
  const { chosen, present, absent } = lineupStatus(members, lineup);
  // Theme tokens only (foreground/destructive): the JPG export swaps those to a
  // light palette, but a `dark:` utility class survives it and would print pale
  // amber on the white image.
  return (
    <div className="space-y-0.5 text-sm">
      <p className="font-medium">
        {!chosen
          ? `⚠️ ยังไม่ได้เลือกรายชื่อคนมา — แสดงทั้งวง ${members.length} คน`
          : absent.length === 0
          ? `มาครบทั้งวง ${members.length} คน`
          : `มางานนี้ ${present.length}/${members.length} คน`}
      </p>
      {absent.length > 0 && (
        <p className="font-semibold text-destructive">
          ขาด: {absent.map(memberLabel).join(", ")}
        </p>
      )}
    </div>
  );
}
