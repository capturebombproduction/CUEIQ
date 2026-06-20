import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Self-service tenant join is CLOSED (RBAC lockdown, supabase/migrations/0016).
// A signed-in account that isn't yet attached to a tenant/band sees this notice —
// an admin must provision their access.
export function JoinDemo() {
  return (
    <div className="mx-auto max-w-md py-10">
      <Card>
        <CardHeader>
          <CardTitle>บัญชียังไม่ได้รับสิทธิ์เข้าวง</CardTitle>
          <CardDescription>
            บัญชีของคุณเข้าสู่ระบบแล้ว แต่ยังไม่ถูกกำหนดให้เข้าวง/ค่ายใด
            กรุณาติดต่อแอดมินค่ายเพื่อขอสิทธิ์ (วงและบทบาทของคุณ)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            แอดมินจะกำหนดบทบาทให้คุณ (Artist Manager / สมาชิกวง / ทีมค่าย)
            จากหน้าจัดการสิทธิ์ แล้วคุณจะเห็นข้อมูลของวงที่ได้รับมอบหมาย
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
