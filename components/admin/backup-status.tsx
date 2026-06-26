import { Database, Download, Clock, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
 * Admin reassurance panel: shows that the daily off-machine DB backup (→ R2) is
 * actually running — last snapshot time + size + how many are retained — with a
 * one-tap download of the newest (gated again server-side in the download route).
 */
export function BackupStatus({ backups }: { backups: BackupObject[] }) {
  const latest = backups[0];
  const totalBytes = backups.reduce((n, b) => n + b.size, 0);
  const stale = latest ? Date.now() - new Date(latest.lastModified).getTime() > STALE_AFTER_MS : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-5 w-5" /> สำรองข้อมูล (Backup อัตโนมัติ → R2)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!latest ? (
          <p className="text-muted-foreground">
            ยังไม่มีไฟล์สำรอง — ระบบสำรองข้อมูลอัตโนมัติวันละครั้ง (ตี 1 ตามเวลาไทย)
            ถ้าเพิ่งตั้งค่า รอรอบแรกก่อนนะครับ
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {stale ? (
                <Clock className="h-4 w-4 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
              )}
              <span className="font-medium">
                สำรองล่าสุด {fmtWhen(latest.lastModified).rel}
              </span>
              <span className="text-muted-foreground">
                · {fmtWhen(latest.lastModified).abs} น. · {fmtBytes(latest.size)}
              </span>
            </div>
            {stale && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                เกิน 26 ชม.แล้วยังไม่มีไฟล์ใหม่ — รอบล่าสุดอาจไม่ทำงาน ลองเช็ก cron/คีย์
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              เก็บไว้ {backups.length} ไฟล์ · รวม {fmtBytes(totalBytes)} (อยู่บน Cloudflare R2 นอกเครื่องนี้)
            </p>
            <Button asChild variant="outline" size="sm">
              <a href="/api/admin/backup/download">
                <Download className="h-4 w-4" /> โหลดไฟล์สำรองล่าสุด
              </a>
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
