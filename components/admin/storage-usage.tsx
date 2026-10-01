import type { CSSProperties } from "react";
import { HardDrive, CircleCheck, TriangleAlert, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const FREE_LIMIT = 10 * 1024 ** 3; // Cloudflare R2 free tier: 10 GB

function fmtSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/**
 * Admin storage gauge for the audio bucket (Cloudflare R2). Shows used / 10 GB
 * free on a `.track` meter, file count, and a plain-language cost note so the label
 * can see headroom at a glance without opening the Cloudflare dashboard. The level
 * is also said in a chip (icon + word), not by the bar's colour alone.
 */
export function StorageUsage({ bytes, count }: { bytes: number; count: number }) {
  const pct = Math.min(100, (bytes / FREE_LIMIT) * 100);
  const level = pct > 90 ? "full" : pct > 75 ? "high" : "ok";
  return (
    <section className="slab flex h-full flex-col gap-2.5 p-4" aria-labelledby="admin-storage">
      <div className="flex items-center justify-between gap-2">
        <h2 id="admin-storage" className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground">
          <HardDrive className="h-4 w-4" aria-hidden /> Storage
        </h2>
        {level === "full" ? (
          <span className="chip chip-danger">
            <OctagonAlert aria-hidden /> ใกล้เต็ม
          </span>
        ) : level === "high" ? (
          <span className="chip chip-warning">
            <TriangleAlert aria-hidden /> เกิน 75%
          </span>
        ) : (
          <span className="chip chip-success">
            <CircleCheck aria-hidden /> เหลือพอ
          </span>
        )}
      </div>
      <p className="leading-none">
        <span className="num text-[28px]">{fmtSize(bytes)}</span>{" "}
        <span className="num text-[16px] text-muted-foreground">/ 10 GB</span>
      </p>
      <div
        className={cn("track", level === "high" && "warn")}
        role="meter"
        aria-label="พื้นที่ที่ใช้ไป"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <span
          style={
            {
              width: `${Math.max(2, pct)}%`,
              ...(level === "full" ? { backgroundColor: "hsl(var(--destructive))" } : {}),
            } as CSSProperties
          }
        />
      </div>
      <div className="flex items-center justify-between text-[12.5px] text-muted-foreground">
        <span>
          <span className="num text-[14px] text-foreground">{count}</span> ไฟล์
        </span>
        <span className="num text-[14px]">{pct.toFixed(1)}%</span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        ฟรี 10 GB + ดาวน์โหลด/สตรีมไม่จำกัด (egress ฟรี) — เกินจากนี้คิด ~$0.015/GB/เดือน
        ({fmtSize(Math.max(0, FREE_LIMIT - bytes))} เหลือในโควต้าฟรี)
      </p>
    </section>
  );
}
