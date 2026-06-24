import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, LogOut, Monitor } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** M1 placeholder authenticated screen — proves the desktop app talks to the SAME
 *  Supabase as the web app (same session/accounts). M2 ports the real shell + pages. */
export function Home() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      setName((u?.user_metadata?.name as string) || u?.email || null);
    });
  }, []);

  const signOut = async () => {
    await createClient().auth.signOut();
    toast.success("ออกจากระบบแล้ว");
  };

  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-primary" /> CueIQ Desktop
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            เชื่อมต่อกับฐานข้อมูลเดียวกับเว็บแล้ว{name ? ` — ${name}` : ""}
          </div>
          <p className="text-sm text-muted-foreground">
            นี่คือเวอร์ชันเดสก์ท็อป (M1: ล็อกอิน + เชื่อม Supabase สำเร็จ) — ขั้นถัดไปจะย้าย
            หน้าจริง (หน้าหลัก / หน้างาน / โหมดไลฟ์) มาให้ครบ แล้วห่อเป็นแอปติดตั้ง Win/Mac
          </p>
          <Button variant="outline" onClick={signOut} className="w-full">
            <LogOut className="h-4 w-4" /> ออกจากระบบ
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
