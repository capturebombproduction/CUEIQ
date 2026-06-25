// Placeholder for nav sections not yet ported to desktop (Overview / Library /
// Training / Artists / Crew / Admin). Keeps the reused MainNav honest — a click
// lands here instead of silently bouncing to the dashboard.
import { Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function ComingSoon({ title }: { title: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <Construction className="h-10 w-10 text-muted-foreground" />
        <p className="text-lg font-semibold">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          ส่วนนี้ยังอยู่บนเว็บ — เวอร์ชันเดสก์ท็อปกำลังทยอยย้ายมาให้ครบ
          (ตอนนี้พร้อมแล้ว: หน้างาน + รายละเอียดงาน)
        </p>
      </CardContent>
    </Card>
  );
}
