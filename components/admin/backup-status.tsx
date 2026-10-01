import { Database, Download, CircleCheck, Hourglass, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BackupObject } from "@/lib/r2";

function fmtBytes(b: number): string {
  const mb = b / (1024 * 1024);
  if (mb < 0.1) return `${(b / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function fmtWhen(iso: string): { abs: string; rel: string } {
  const d = new Date(iso);
  const abs = d.toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel =
    mins < 1
      ? "เมื่อครู่"
      : mins < 60
        ? `${mins} นาทีที่แล้ว`
        : mins < 1440
          ? `${Math.round(mins / 60)} ชม.ที่แล้ว`
          : `${Math.round(mins / 1440)} วันที่แล้ว`;
  return { abs, rel };
}

// How recent is "healthy" — the cron runs daily, so anything older than ~26h means
// the last run was skipped/failed and is worth a glance.
const STALE_AFTER_MS = 26 * 3600 * 1000;

/**
 * Admin reassurance tile: shows that the daily off-machine DB backup (→ R2) is
 * actually running — last snapshot time + size + how many are retained — with a
 * one-tap download of the newest (gated again server-side in the download route).
 * Its state is a chip (icon + word), never a colour alone.
 */
export function BackupStatus({ backups }: { backups: BackupObject[] }) {
  const latest = backups[0];
  const totalBytes = backups.reduce((n, b) => n + b.size, 0);
  const stale = latest ? Date.now() - new Date(latest.lastModified).getTime() > STALE_AFTER_MS : false;
  const when = latest ? fmtWhen(latest.lastModified) : null;

  return (
    <section className="slab flex h-full flex-col gap-2.5 p-4" aria-labelledby="admin-backup">
      <div className="flex items-center justify-between gap-2">
        <h2 id="admin-backup" className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground">
          <Database className="h-4 w-4" aria-hidden /> Backup
        </h2>
        {!latest ? (
          <span className="chip chip-neutral">
            <CircleDashed aria-hidden /> ยังไม่มีไฟล์
          </span>
        ) : stale ? (
          <span className="chip chip-warning">
            <Hourglass aria-hidden /> ขาดช่วง
          </span>
        ) : (
          <span className="chip chip-success">
            <CircleCheck aria-hidden /> ทำงานปกติ
          </span>
        )}
      </div>
      {!latest || !when ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          ยังไม่มีไฟล์สำรอง — ระบบสำรองข้อมูลอัตโนมัติวันละครั้ง (ตี 1 ตามเวลาไทย)
          ถ้าเพิ่งตั้งค่า รอรอบแรกก่อนนะครับ
        </p>
      ) : (
        <>
          <div>
            <p className="text-[15px] font-semibold">สำรองล่าสุด {when.rel}</p>
            <p className="text-[13px] text-muted-foreground">
              <span className="num text-[15px] text-foreground">{when.abs}</span> น. ·{" "}
              <span className="num text-[15px] text-foreground">{fmtBytes(latest.size)}</span>
            </p>
          </div>
          {stale && (
            <p className="text-[12.5px] text-warning-ink">
              เกิน 26 ชม.แล้วยังไม่มีไฟล์ใหม่ — รอบล่าสุดอาจไม่ทำงาน ลองเช็ก cron/คีย์
            </p>
          )}
          <p className="text-[12.5px] text-muted-foreground">
            เก็บไว้ <span className="num text-[14px]">{backups.length}</span> ไฟล์ · รวม{" "}
            <span className="num text-[14px]">{fmtBytes(totalBytes)}</span> (อยู่บน Cloudflare R2 นอกเครื่องนี้)
          </p>
          <Button asChild variant="secondary" className="mt-auto self-start">
            <a href="/api/admin/backup/download">
              <Download aria-hidden /> โหลดไฟล์สำรองล่าสุด
            </a>
          </Button>
        </>
      )}
    </section>
  );
}
