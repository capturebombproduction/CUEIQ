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
  X,
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

// Errors that are noise even if they slipped past the reporter filter (old rows
// pre-dating the isDevOrigin + hydration guard in client-log.ts).
const NOISE_PATTERNS = [
  /Minified React error #(418|419|420|421|422|423|425)\b/i,
  /hydrat/i,
  /Text content does not match server-rendered HTML/i,
  /webpack-internal:/i,
];
function isNoise(r: ErrorRow): boolean {
  if (r.url?.startsWith("webpack-internal:")) return true;
  if (r.url?.includes("localhost") || r.url?.includes("127.0.0.1")) return true;
  return NOISE_PATTERNS.some((re) => re.test(r.message) || re.test(r.url ?? ""));
}

// Group consecutive identical messages so the inbox doesn't flood with the same
// error repeated across sessions/deploys.
interface ErrorGroup {
  key: string;
  count: number;
  first: ErrorRow;
  last_seen: string;
  ids: string[];
}
function groupErrors(rows: ErrorRow[]): ErrorGroup[] {
  const map = new Map<string, ErrorGroup>();
  for (const r of rows) {
    const key = `${r.kind}:${r.message.slice(0, 80)}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      existing.ids.push(r.id);
      if (r.created_at > existing.last_seen) existing.last_seen = r.created_at;
    } else {
      map.set(key, { key, count: 1, first: r, last_seen: r.created_at, ids: [r.id] });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
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

function shortUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname + (u.hash || "");
  } catch {
    return url.slice(0, 60);
  }
}

export function DevInbox() {
  const confirm = useConfirm();
  const [fb, setFb] = useState<FeedbackRow[]>([]);
  const [errs, setErrs] = useState<ErrorRow[]>([]);
  const [showNoise, setShowNoise] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const supabase = createClient();
    const [f, e] = await Promise.all([
      supabase.from("feedback").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("client_errors").select("*").order("created_at", { ascending: false }).limit(200),
    ]);
    setFb((f.data ?? []) as FeedbackRow[]);
    setErrs((e.data ?? []) as ErrorRow[]);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

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
  async function delGroup(ids: string[]) {
    if (!ids.length) return;
    setErrs((p) => p.filter((r) => !ids.includes(r.id)));
    await createClient().from("client_errors").delete().in("id", ids);
  }
  async function clearNoise() {
    if (!(await confirm({ title: "ล้าง noise ทั้งหมด?", description: "ลบ error ที่เป็น hydration / localhost ออก — ลบถาวร" }))) return;
    const noiseIds = errs.filter(isNoise).map((r) => r.id);
    if (!noiseIds.length) return;
    setErrs((p) => p.filter((r) => !noiseIds.includes(r.id)));
    await createClient().from("client_errors").delete().in("id", noiseIds);
  }
  async function clearAll() {
    if (!(await confirm({ title: "ล้าง error ทั้งหมด?", description: "ลบทุก row ในตาราง client_errors — ลบถาวร" }))) return;
    setErrs([]);
    // delete via RLS (admin only), bulk by tenant
    const supabase = createClient();
    const { data: tenant } = await supabase.from("tenants").select("id").single();
    if (tenant) await supabase.from("client_errors").delete().eq("tenant_id", tenant.id);
  }

  const openCount = fb.filter((r) => r.status !== "done").length;
  const realErrs = errs.filter((r) => !isNoise(r));
  const noiseErrs = errs.filter(isNoise);
  const visibleErrs = showNoise ? errs : realErrs;
  const groups = groupErrors(visibleErrs);

  return (
    <Tabs defaultValue="feedback" className="w-full">
      <div className="flex items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="feedback">
            ฟีดแบค
            {openCount > 0 && (
              <Badge variant="secondary" className="ml-1.5">{openCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="errors">
            ปัญหา (Errors)
            {realErrs.length > 0 && (
              <Badge variant="secondary" className="ml-1.5">{realErrs.length}</Badge>
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
            <div key={r.id} className={`rounded-lg border bg-card p-3 ${done ? "opacity-50" : ""}`}>
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
                    variant="ghost" size="icon"
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
        {/* toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{realErrs.length} error จริง</span>
            {noiseErrs.length > 0 && (
              <button
                className="underline-offset-2 hover:underline"
                onClick={() => setShowNoise((v) => !v)}
              >
                {showNoise ? `ซ่อน noise (${noiseErrs.length})` : `+ noise ${noiseErrs.length}`}
              </button>
            )}
          </div>
          <div className="flex gap-1">
            {noiseErrs.length > 0 && (
              <Button variant="outline" size="sm" onClick={clearNoise} className="text-xs">
                <X className="h-3.5 w-3.5" /> ล้าง noise
              </Button>
            )}
            {errs.length > 0 && (
              <Button variant="outline" size="sm" onClick={clearAll} className="text-xs text-destructive hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" /> ล้างทั้งหมด
              </Button>
            )}
          </div>
        </div>

        {!loading && groups.length === 0 && (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            ไม่มี error ที่ถูกบันทึก — ดีงาม ✨
          </p>
        )}
        {groups.map((g) => {
          const r = g.first;
          const noise = isNoise(r);
          return (
            <div key={g.key} className={`rounded-lg border bg-card p-3 ${noise ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <AlertTriangle className={`h-3.5 w-3.5 ${noise ? "text-muted-foreground" : "text-destructive"}`} />
                    <span>{when(g.last_seen)}</span>
                    <Badge variant="outline">{r.kind}</Badge>
                    {g.count > 1 && (
                      <Badge variant="secondary">×{g.count}</Badge>
                    )}
                    {r.app_version && <span>· {r.app_version}</span>}
                    {noise && <Badge variant="outline" className="text-[10px]">noise</Badge>}
                  </div>
                  <p className="break-words text-sm font-medium">{r.message}</p>
                  {r.url && (
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {shortUrl(r.url)}
                    </p>
                  )}
                  {r.stack && (
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
                      {r.stack}
                    </pre>
                  )}
                </div>
                <Button
                  variant="ghost" size="icon" title="ลบกลุ่มนี้"
                  onClick={() => delGroup(g.ids)}
                  className="shrink-0"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </TabsContent>
    </Tabs>
  );
}
