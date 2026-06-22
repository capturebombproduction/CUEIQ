"use client";

import { useEffect, useState } from "react";
import {
  Bug,
  Lightbulb,
  MessageCircle,
  Check,
  Trash2,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface FeedbackRow {
  id: string;
  category: string;
  message: string;
  status: string;
  context: { path?: string | null; commit?: string | null; ua?: string | null } | null;
  created_at: string;
}
interface ErrorRow {
  id: string;
  kind: string;
  message: string;
  stack: string | null;
  url: string | null;
  app_version: string | null;
  created_at: string;
}

const CAT_ICON: Record<string, typeof Bug> = {
  bug: Bug,
  idea: Lightbulb,
  other: MessageCircle,
};

function when(iso: string) {
  return new Date(iso).toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Admin-only inbox for the two feedback tools: user-submitted feedback (triage:
 * mark done / delete) and auto-captured client errors (read + clear). Reads via
 * RLS (admins see all rows of their tenant).
 */
export function DevInbox() {
  const confirm = useConfirm();
  const [fb, setFb] = useState<FeedbackRow[]>([]);
  const [errs, setErrs] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const supabase = createClient();
    const [f, e] = await Promise.all([
      supabase.from("feedback").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("client_errors").select("*").order("created_at", { ascending: false }).limit(100),
    ]);
    setFb((f.data ?? []) as FeedbackRow[]);
    setErrs((e.data ?? []) as ErrorRow[]);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleDone(id: string, status: string) {
    const next = status === "done" ? "open" : "done";
    setFb((p) => p.map((r) => (r.id === id ? { ...r, status: next } : r)));
    await createClient().from("feedback").update({ status: next }).eq("id", id);
  }
  async function delFb(id: string) {
    if (!(await confirm({ title: "ลบฟีดแบคนี้?", description: "ลบถาวร กู้คืนไม่ได้" }))) return;
    setFb((p) => p.filter((r) => r.id !== id));
    await createClient().from("feedback").delete().eq("id", id);
  }
  async function delErr(id: string) {
    if (!(await confirm({ title: "ลบ error นี้?", description: "ลบถาวร กู้คืนไม่ได้" }))) return;
    setErrs((p) => p.filter((r) => r.id !== id));
    await createClient().from("client_errors").delete().eq("id", id);
  }

  const openCount = fb.filter((r) => r.status !== "done").length;

  return (
    <Tabs defaultValue="feedback" className="w-full">
      <div className="flex items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="feedback">
            ฟีดแบค
            {openCount > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {openCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="errors">
            ปัญหา (Errors)
            {errs.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">
                {errs.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon" title="โหลดใหม่" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {/* feedback */}
      <TabsContent value="feedback" className="mt-3 space-y-2">
        {!loading && fb.length === 0 && (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            ยังไม่มีฟีดแบค
          </p>
        )}
        {fb.map((r) => {
          const Icon = CAT_ICON[r.category] ?? MessageCircle;
          const done = r.status === "done";
          return (
            <div
              key={r.id}
              className={`rounded-lg border bg-card p-3 ${done ? "opacity-50" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                    <span>{when(r.created_at)}</span>
                    {r.context?.path && (
                      <span className="truncate font-mono">· {r.context.path}</span>
                    )}
                    {r.context?.commit && <span>· {r.context.commit}</span>}
                  </div>
                  <p className={`whitespace-pre-wrap text-sm ${done ? "line-through" : ""}`}>
                    {r.message}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    title={done ? "ทำเป็นยังไม่เสร็จ" : "ทำเครื่องหมายว่าจัดการแล้ว"}
                    onClick={() => toggleDone(r.id, r.status)}
                    className={done ? "text-success" : ""}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="ลบ" onClick={() => delFb(r.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </TabsContent>

      {/* errors */}
      <TabsContent value="errors" className="mt-3 space-y-2">
        {!loading && errs.length === 0 && (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            ไม่มี error ที่ถูกบันทึก — ดีงาม ✨
          </p>
        )}
        {errs.map((r) => (
          <div key={r.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                  <span>{when(r.created_at)}</span>
                  <Badge variant="outline">{r.kind}</Badge>
                  {r.app_version && <span>· {r.app_version}</span>}
                </div>
                <p className="break-words text-sm font-medium">{r.message}</p>
                {r.url && (
                  <p className="truncate font-mono text-xs text-muted-foreground">{r.url}</p>
                )}
                {r.stack && (
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
                    {r.stack}
                  </pre>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                title="ลบ"
                onClick={() => delErr(r.id)}
                className="shrink-0"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </TabsContent>
    </Tabs>
  );
}
