// The write seam for management data (⭐#1 step 2, docs/desktop-offline-management.md
// §3c/§5). EventForm routes its create/update through saveEventWrite instead of
// calling Supabase inline, giving the desktop ONE place to catch a network failure
// and queue the write for later sync.
//
// On the WEB nothing registers a queue sink, so behavior is byte-identical to the
// old inline calls: try online, surface the error. Only the desktop boot
// (desktop/src/main.tsx) registers a sink pointing at its IndexedDB outbox — then a
// network failure (and only a network failure — RLS/validation errors still surface)
// becomes a queued op + an immediate optimistic result.
import { createClient } from "@/lib/supabase/client";
import {
  isQueueableWriteError,
  newEventId,
  type NewMgmtOp,
} from "@/lib/mgmt-outbox";
import type { EventRow } from "@/lib/types";

type MgmtQueueSink = (op: NewMgmtOp) => Promise<void>;

let queueSink: MgmtQueueSink | null = null;

/** Desktop-only: point failed writes at the offline outbox. Web never calls this. */
export function registerMgmtQueueSink(sink: MgmtQueueSink | null): void {
  queueSink = sink;
}

export type SaveEventResult =
  | { ok: true; id: string; queued: boolean }
  | { ok: false; message?: string };

export async function saveEventWrite(args: {
  mode: "create" | "edit";
  payload: Partial<EventRow>;
  /** edit: the row being edited */
  eventId?: string;
  /** create: stamped as created_by */
  createdBy?: string;
  /** edit: event.updated_at we loaded — the online-wins guard's reference point */
  baseUpdatedAt?: string | null;
}): Promise<SaveEventResult> {
  const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
  // Known-offline with a queue available: skip the doomed network attempt.
  if (queueSink && !onLine) return queueWrite(args);

  try {
    const supabase = createClient();
    if (args.mode === "create") {
      const { data, error } = await supabase
        .from("events")
        .insert({ ...args.payload, created_by: args.createdBy })
        .select("id")
        .single();
      if (!error && data) return { ok: true, id: data.id as string, queued: false };
      if (queueSink && isQueueableWriteError(error?.message, onLine)) return queueWrite(args);
      return { ok: false, message: error?.message };
    }
    const { error } = await supabase
      .from("events")
      .update(args.payload)
      .eq("id", args.eventId!);
    if (!error) return { ok: true, id: args.eventId!, queued: false };
    if (queueSink && isQueueableWriteError(error.message, onLine)) return queueWrite(args);
    return { ok: false, message: error.message };
  } catch (e) {
    // supabase-js normally returns errors; an actual throw here is a transport
    // failure — queueable when the desktop sink exists.
    if (queueSink) return queueWrite(args);
    return { ok: false, message: e instanceof Error ? e.message : undefined };
  }
}

async function queueWrite(
  args: Parameters<typeof saveEventWrite>[0]
): Promise<SaveEventResult> {
  const sink = queueSink!;
  try {
    if (args.mode === "create") {
      const id = newEventId();
      await sink({
        kind: "event.create",
        id,
        values: { ...args.payload, created_by: args.createdBy ?? null },
      });
      return { ok: true, id, queued: true };
    }
    await sink({
      kind: "event.update",
      id: args.eventId!,
      patch: args.payload,
      base: args.baseUpdatedAt ? Date.parse(args.baseUpdatedAt) || null : null,
    });
    return { ok: true, id: args.eventId!, queued: true };
  } catch {
    // IndexedDB unavailable/full — the write is genuinely lost; tell the user.
    return { ok: false, message: "บันทึกออฟไลน์ไม่สำเร็จ (พื้นที่เก็บข้อมูลในเครื่องมีปัญหา)" };
  }
}
