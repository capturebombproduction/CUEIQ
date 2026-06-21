import { Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const FREE_LIMIT = 10 * 1024 ** 3; // Cloudflare R2 free tier: 10 GB

function fmtSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/**
 * Admin storage gauge for the audio bucket (Cloudflare R2). Shows used / 10 GB
 * free, a colour-coded bar, file count, and a plain-language cost note so the
 * label can see headroom at a glance without opening the Cloudflare dashboard.
 */
export function StorageUsage({ bytes, count }: { bytes: number; count: number }) {
  const pct = Math.min(100, (bytes / FREE_LIMIT) * 100);
  const tone =
    pct > 90 ? "bg-destructive" : pct > 75 ? "bg-amber-500" : "bg-primary";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" /> พื้นที่จัดเก็บไฟล์เสียง (Cloudflare R2)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-end justify-between gap-2">
          <span className="text-2xl font-bold tabular-nums">
            {fmtSize(bytes)}{" "}
            <span className="text-base font-normal text-muted-foreground">
              / 10 GB
            </span>
          </span>
          <span className="text-muted-foreground tabular-nums">
            {count} ไฟล์ · {pct.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${tone}`}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          ฟรี 10 GB + ดาวน์โหลด/สตรีมไม่จำกัด (egress ฟรี) — เกินจากนี้คิด ~$0.015/GB/เดือน
          ({fmtSize(Math.max(0, FREE_LIMIT - bytes))} เหลือในโควต้าฟรี)
        </p>
      </CardContent>
    </Card>
  );
}
