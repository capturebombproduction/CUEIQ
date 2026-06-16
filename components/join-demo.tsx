"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function JoinDemo() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function join() {
    setLoading(true);
    const { error } = await createClient().rpc("join_demo");
    setLoading(false);
    if (error) {
      toast.error("เข้าร่วม workspace ไม่สำเร็จ", {
        description:
          error.message +
          " — ตรวจสอบว่าได้รัน supabase/migrations + supabase/seed.sql แล้ว",
      });
      return;
    }
    toast.success("เข้าร่วม Capture Bomb Production แล้ว 🎉");
    window.location.href = "/dashboard";
  }

  return (
    <div className="mx-auto max-w-md py-10">
      <Card>
        <CardHeader>
          <CardTitle>ยังไม่ได้อยู่ใน Workspace</CardTitle>
          <CardDescription>
            บัญชีของคุณยังไม่ถูกผูกกับค่าย/ทีมใด เข้าร่วม Demo Workspace
            (Capture Bomb Production) เพื่อดูข้อมูลตัวอย่าง VANTAFLARE
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={join} disabled={loading} className="w-full">
            {loading ? "กำลังเข้าร่วม…" : "เข้าร่วม Demo Workspace"}
          </Button>
          <p className="text-xs text-muted-foreground">
            ถ้ากดแล้วไม่สำเร็จ แปลว่ายังไม่ได้ตั้งค่าฐานข้อมูล —
            เปิด Supabase SQL Editor แล้วรัน{" "}
            <code className="rounded bg-muted px-1">
              supabase/migrations/0001_init.sql
            </code>{" "}
            ตามด้วย{" "}
            <code className="rounded bg-muted px-1">supabase/seed.sql</code>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
