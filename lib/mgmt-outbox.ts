// Offline MANAGEMENT outbox — the PURE core (⭐#1 step 2, design in
// docs/desktop-offline-management.md). This file holds only the deterministic,
// side-effect-free logic:
//   • applyPending  — overlay queued offline writes onto a server/cache list so an
//                     offline create/edit is VISIBLE immediately (the trap that
//                     sank the earlier naive attempt: "saved but can't open it").
//   • shouldApplyOnFlush — the "online wins" reconciliation guard for the master
//                     zone (docs/offline-first-plan.md §5): a queued edit is applied
//                     on reconnect ONLY if the server row hasn't advanced past the
//                     value we edited against; otherwise it's a conflict to park.
//   • newEventId    — a client-minted uuid PK so an offline-created event has a
//                     stable id up front (no temp→real id remap on flush).
//   • planEnqueue   — coalesce a new write into the queue (one op per event) so a
//                     flushed op can't false-conflict a later op for the same row.
//   • materializeEventRow / describeOp / isQueueableWriteError — display + flush
//                     classification helpers shared by the desktop wiring.
//
// NOT here (deliberately): the IndexedDB queue I/O and the flush loop — they live in
// desktop/src/data/mgmt-outbox.ts so the web build never carries them. This file
// stays pure (unit-tested in lib/mgmt-outbox.test.ts) and is shared by the desktop
// queue, the loader overlays, and the EventForm write seam (lib/mgmt-write.ts).
import type { AudioUploadOp } from "@/lib/audio-upload-queue";
import type { EventRow } from "@/lib/types";

/**
 * A management write before it's queued — no `seq` yet (the queue assigns one).
 * `base` is the epoch-ms `updated_at` of the row the edit was made against — null
 * when unknown; used by shouldApplyOnFlush to detect "the server changed under me".
 */
export type ChildListKind =
  | "setlist.upsert"
  | "schedule.upsert"
  | "mic.upsert"
  | "lineup.upsert";

/**
 * Whole-list snapshot of one event's child table (⭐#1 step 5). The editors write
 * per-row online; offline we queue the ENTIRE post-edit list instead — one op per
 * (event × table) — so ~20 heterogeneous write patterns replay as a single
 * idempotent replace-set. `id` is the EVENT id (the same grouping key event ops
 * use). `rows` are sanitized write-column projections (member_ids for lineup).
 * `base` is a fingerprint of the rows as last seen from the server — the child
 * tables have no updated_at, so the online-wins guard compares fingerprints.
 */
export type ChildListOp = {
  kind: ChildListKind;
  id: string;
  tenantId: string;
  rows: unknown[];
  base: string | null;
  /** Display only (status chip / conflict list) — the event's name if known. */
  eventName?: string | null;
};

/**
 * Fired on `window` after any queue change so the shell's status chips — and the
 * Library's "รออัปโหลด" badges — can refresh. Lives here rather than in the
 * desktop store so a SHARED component can listen for it without importing
 * desktop-only code (on the web nothing ever dispatches it).
 */
export const MGMT_OUTBOX_EVENT = "cueiq:mgmt-outbox-change";

export type NewMgmtOp =
  | { kind: "event.create"; id: string; values: Partial<EventRow> }
  | { kind: "event.update"; id: string; patch: Partial<EventRow>; base: number | null }
  | { kind: "event.delete"; id: string; base: number | null }
  | ChildListOp
  | AudioUploadOp;

/** The event-row ops (whose `base` is an epoch-ms timestamp, not a fingerprint). */
export type EventScopedOp = Exclude<NewMgmtOp, ChildListOp | AudioUploadOp>;

export function isChildListOp(op: NewMgmtOp): op is ChildListOp {
  return (
    op.kind === "setlist.upsert" ||
    op.kind === "schedule.upsert" ||
    op.kind === "mic.upsert" ||
    op.kind === "lineup.upsert"
  );
}

/**
 * ⭐#1 step 6 — a queued audio upload (lib/audio-upload-queue.ts). It rides this
 * queue for the chips, the conflict panel and the session gating, but it is not
 * an EVENT op: its `id` is a songId, so every event-scoped code path below has to
 * step over it. Grouped here so that stays impossible to forget.
 */
export function isAudioUploadOp(op: NewMgmtOp): op is AudioUploadOp {
  return op.kind === "audio.upload";
}

/**
 * A queued offline management write. `seq` is a per-device monotonic counter so a
 * create-then-edits replays in the exact order it was made.
 */
export type MgmtOp = NewMgmtOp & { seq: number };

/** Ascending by seq — the order the writes happened, so replay/overlay is stable. */
function bySeq(a: MgmtOp, b: MgmtOp): number {
  return a.seq - b.seq;
}

/**
 * Overlay the pending ops onto a list of rows (keyed by `id`). Pure — returns a new
 * array, never mutates. A create for an id already present is skipped (the server
 * caught up); an update shallow-merges its patch; a delete drops the row.
 */
export function applyPending<T extends { id: string }>(rows: T[], ops: MgmtOp[]): T[] {
  let out = rows.slice();
  for (const op of ops.slice().sort(bySeq)) {
    if (isChildListOp(op)) continue; // child-table snapshots don't touch the events list
    // Neither does an audio upload — and its `id` is a songId, so falling through
    // to the delete branch below would drop an unrelated event off the dashboard.
    if (isAudioUploadOp(op)) continue;
    if (op.kind === "event.create") {
      if (!out.some((r) => r.id === op.id)) {
        // A freshly-created offline event: surface it at the top with its client id.
        out = [{ ...op.values, id: op.id } as unknown as T, ...out];
      }
    } else if (op.kind === "event.update") {
      out = out.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r));
    } else {
      out = out.filter((r) => r.id !== op.id);
    }
  }
  return out;
}

/**
 * Overlay the pending child-list snapshots for `eventId` onto a loaded event
 * bundle, so an offline setlist/schedule/mic/lineup edit is visible when the
 * event is reopened. A snapshot REPLACES its whole list (that's what will land on
 * flush). Mic rows get a created_at fallback (dropped from the stored projection —
 * the column is server-defaulted and display-only).
 */
export function applyPendingChildren<
  T extends { setlist: unknown; schedule: unknown; micMap: unknown; lineup: unknown },
>(bundle: T, ops: MgmtOp[], eventId: string): T {
  const out = { ...bundle } as T & Record<string, unknown>;
  for (const op of ops.slice().sort(bySeq)) {
    if (!isChildListOp(op) || op.id !== eventId) continue;
    if (op.kind === "setlist.upsert") out.setlist = op.rows;
    else if (op.kind === "schedule.upsert") out.schedule = op.rows;
    else if (op.kind === "mic.upsert")
      out.micMap = (op.rows as Record<string, unknown>[]).map((r) => ({
        created_at: new Date(0).toISOString(),
        ...r,
      }));
    else out.lineup = op.rows;
  }
  return out;
}

/**
 * "Online wins" reconciliation for the master/stage zone: on reconnect, a queued
 * edit is applied ONLY if the server row hasn't changed since we based our edit on
 * it. A create always applies (brand-new row, no base). A missing base or unknown
 * server timestamp falls through to apply (best-effort — we only BLOCK when we can
 * prove the server moved ahead). Returns false → park the op as a conflict.
 */
export function shouldApplyOnFlush(
  op: EventScopedOp,
  serverUpdatedAtMs: number | null,
  /** updated_at (ms) our OWN flush last wrote to this row — see selfWriteMs in the desktop wiring. */
  lastOwnWriteMs: number | null = null
): boolean {
  if (op.kind === "event.create") return true;
  if (op.base == null || serverUpdatedAtMs == null) return true;
  if (serverUpdatedAtMs <= op.base) return true;
  // The server only advanced because our own flush just landed an EARLIER op for
  // this row (same session, older base) — a later edit must not park as a false
  // conflict against our own write.
  return lastOwnWriteMs != null && serverUpdatedAtMs === lastOwnWriteMs;
}

/**
 * Does the server row already contain exactly this patch? Used to make an
 * event.update replay idempotent: a crash between apply and delete (or a second
 * instance re-running the same op) must see "already applied", not a false
 * conflict. Values are normalized like sanitizeChildRows (undefined → null,
 * editor "HH:MM" → server "HH:MM:SS", timestamptz → the instant it names) and
 * compared canonically (jsonb-safe).
 */
export function eventPatchApplied(
  patch: Record<string, unknown>,
  serverRow: Record<string, unknown> | null | undefined
): boolean {
  if (!serverRow) return false;
  const norm = (v: unknown): string => {
    if (v === undefined) v = null;
    if (typeof v === "string") {
      if (/^\d{2}:\d{2}$/.test(v)) v = `${v}:00`;
      else if (ISO_DATETIME.test(v)) {
        // timestamptz (events.deadline): the form sends "…T16:59:00.000Z", the
        // server renders "…T16:59:00+00:00" — same instant, different text.
        const ms = parseInstantMs(v);
        if (ms != null) v = `@${ms}`;
      }
    }
    return stableStringify(v);
  };
  return Object.keys(patch).every((k) => norm(patch[k]) === norm(serverRow[k]));
}

/** Date-TIME strings only — a bare "YYYY-MM-DD" (event_date) is already canonical. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Epoch ms of an ISO/Postgres timestamp, or null when it can't be parsed. */
function parseInstantMs(v: string): number | null {
  let ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    // Postgres' own text rendering ("2026-07-24 16:59:00+00") isn't always accepted.
    ms = Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  }
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Postgres unique violation (23505) — e.g. migration 0036's one-photo-per-event
 * partial index colliding with a schedule snapshot's upsert-before-delete replay.
 */
export function isUniqueViolation(
  code: string | null | undefined,
  message: string | null | undefined
): boolean {
  if (code === "23505") return true;
  return !!message && /duplicate key value violates unique/i.test(message);
}

/**
 * Migration 0037's approval guard rejecting a write ("only an approver may approve
 * an event"). A queued event.update carries the WHOLE EventForm payload, so an
 * offline edit that never touched the status can be refused just because the
 * server's status moved while this device was offline — the caller retries
 * without `status` and surfaces a Thai reason instead of the raw exception.
 */
export function isApprovalGuardError(message: string | null | undefined): boolean {
  return !!message && /only an approver may approve/i.test(message);
}

/**
 * Rev bookkeeping for queue records: bumped on every coalescing put, so a flush
 * can delete a record ONLY when it still holds the op that was applied (a merged
 * newer edit stays queued instead of being silently destroyed).
 */
export function nextOpRev(prev: number | null | undefined): number {
  return (typeof prev === "number" && Number.isFinite(prev) ? prev : 0) + 1;
}

// ---------------------------------------------------------------------------
// Child-list snapshots (⭐#1 step 5) — tables, projections, fingerprint guard
// ---------------------------------------------------------------------------

/** Supabase table behind each child-list op. */
export const CHILD_TABLES: Record<ChildListKind, string> = {
  "setlist.upsert": "setlist_items",
  "schedule.upsert": "schedule_items",
  "mic.upsert": "mic_assignments",
  "lineup.upsert": "event_members",
};

/**
 * Exactly the columns a snapshot writes (and fingerprints). Server-defaulted
 * columns we never set (mic_assignments.created_at) stay out so an upsert can't
 * clobber them and the fingerprint can't false-mismatch on them.
 */
export const CHILD_WRITE_COLUMNS: Record<Exclude<ChildListKind, "lineup.upsert">, string[]> = {
  "setlist.upsert": [
    "id",
    "tenant_id",
    "event_id",
    "kind",
    "title",
    "duration_seconds",
    "buffer_before_seconds",
    "buffer_after_seconds",
    "mic_slots",
    "notes",
    "sort_order",
    "song_id",
    "audio_path",
    "audio_name",
    "loop_audio",
  ],
  "schedule.upsert": [
    "id",
    "tenant_id",
    "event_id",
    "kind",
    "label",
    "location",
    "start_time",
    "end_time",
    "notes",
    "sort_order",
  ],
  "mic.upsert": ["id", "tenant_id", "event_id", "mic_number", "holder_name", "order_index"],
};

/**
 * Project rows down to the write columns with normalized values, so the stored
 * op, the flush payload, and both sides of the fingerprint are byte-comparable:
 * undefined → null, editor "HH:MM" times → the server's "HH:MM:SS". Lineup rows
 * are member_ids — sorted (set semantics, order never matters).
 */
export function sanitizeChildRows(kind: ChildListKind, rows: unknown[]): unknown[] {
  if (kind === "lineup.upsert") return (rows as string[]).slice().sort();
  const cols = CHILD_WRITE_COLUMNS[kind];
  return (rows as Record<string, unknown>[]).map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of cols) {
      let v = r[c] ?? null;
      if (
        kind === "schedule.upsert" &&
        (c === "start_time" || c === "end_time") &&
        typeof v === "string" &&
        /^\d{2}:\d{2}$/.test(v)
      ) {
        v = `${v}:00`;
      }
      out[c] = v;
    }
    return out;
  });
}

/** JSON.stringify with recursively sorted object keys (jsonb round-trips reorder them). */
function stableStringify(v: unknown): string {
  if (v === undefined || v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * Canonical fingerprint of one event's child list — row order independent (sorted
 * by id / member_id), key order independent, projection-normalized. Equal
 * fingerprints ⇔ the lists are the same as far as a snapshot write is concerned.
 */
export function fingerprintChildRows(kind: ChildListKind, rows: unknown[]): string {
  const sane = sanitizeChildRows(kind, rows);
  if (kind === "lineup.upsert") return JSON.stringify(sane);
  const sorted = (sane as Record<string, unknown>[])
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return stableStringify(sorted);
}

/**
 * Online-wins reconciliation for a child-list snapshot (no updated_at on these
 * tables → compare fingerprints):
 *  • server already matches MY snapshot → "already-applied" (a re-run after a
 *    half-completed flush must not park itself as a false conflict)
 *  • server differs from the rows I based my edit on → "conflict" (park it)
 *  • otherwise (server still as I saw it, or no base to compare) → "apply"
 */
export function childFlushDecision(
  op: ChildListOp,
  serverRows: unknown[]
): "apply" | "already-applied" | "conflict" {
  const serverFp = fingerprintChildRows(op.kind, serverRows);
  if (serverFp === fingerprintChildRows(op.kind, op.rows)) return "already-applied";
  if (op.base != null && serverFp !== op.base) return "conflict";
  return "apply";
}

/**
 * Coalesce an incoming write into the queue (pure planner — the IndexedDB layer
 * executes the plan). Mirrors show-run-outbox's "last value per datum" so the queue
 * never holds two ops for the same event. That matters beyond tidiness: flushing
 * op 1 bumps the server's `updated_at`, so a SECOND queued edit for the same event
 * (whose `base` predates our own flush) would trip the online-wins guard and park
 * as a false conflict. Merging at enqueue time makes that impossible.
 *   • update onto a queued create → fold the patch into the create's values
 *   • update onto a queued update → merge patches, keep the ORIGINAL base
 *   • delete onto a queued create → both cancel out (server never saw the row)
 *   • delete onto a queued update → the delete supersedes it
 */
export interface EnqueuePlan {
  /** Existing queue records to remove (superseded / cancelled out). */
  dropSeqs: number[];
  /** Overwrite this existing record with `op` (null → append as a new record). */
  replaceSeq: number | null;
  /** The op to store — null when the write cancelled out entirely. */
  op: NewMgmtOp | null;
}

export function planEnqueue(existing: MgmtOp[], incoming: NewMgmtOp): EnqueuePlan {
  if (incoming.kind === "event.create") {
    // Creates mint a fresh uuid — they can never coalesce with anything.
    return { dropSeqs: [], replaceSeq: null, op: incoming };
  }
  const mine = existing.filter((o) => o.id === incoming.id).sort(bySeq);

  if (isAudioUploadOp(incoming)) {
    // One pending upload per song: picking file A and then file B while offline
    // should put B in the library, not both in sequence. The retained `basePath`
    // is the FIRST one's — it records the master as it stood before this device
    // went offline, which is the only reference that can tell us whether someone
    // else has replaced it since. Keeping the later, locally-advanced value would
    // compare our own work against itself and call every collision clean.
    const prev = mine.find((o) => o.kind === "audio.upload");
    if (prev && isAudioUploadOp(prev)) {
      return { dropSeqs: [], replaceSeq: prev.seq, op: { ...incoming, basePath: prev.basePath } };
    }
    return { dropSeqs: [], replaceSeq: null, op: incoming };
  }

  if (isChildListOp(incoming)) {
    // One snapshot per (event × table): a newer snapshot supersedes the queued one
    // in place, keeping the ORIGINAL base — both edits were made against the same
    // last-seen server list, and that's the guard's reference point.
    const prev = mine.find((o) => o.kind === incoming.kind);
    if (prev && isChildListOp(prev)) {
      return { dropSeqs: [], replaceSeq: prev.seq, op: { ...incoming, base: prev.base } };
    }
    return { dropSeqs: [], replaceSeq: null, op: incoming };
  }

  const create = mine.find((o) => o.kind === "event.create");
  const update = mine.find((o) => o.kind === "event.update");
  const del = mine.find((o) => o.kind === "event.delete");

  if (incoming.kind === "event.update") {
    if (create && create.kind === "event.create") {
      return {
        dropSeqs: [],
        replaceSeq: create.seq,
        op: { kind: "event.create", id: incoming.id, values: { ...create.values, ...incoming.patch } },
      };
    }
    if (update && update.kind === "event.update") {
      return {
        dropSeqs: [],
        replaceSeq: update.seq,
        op: {
          kind: "event.update",
          id: incoming.id,
          patch: { ...update.patch, ...incoming.patch },
          // Both edits were made against the same last-seen server row — the base
          // must stay the ORIGINAL timestamp, or the guard loses its reference.
          base: update.base,
        },
      };
    }
    return { dropSeqs: [], replaceSeq: null, op: incoming };
  }

  // incoming delete
  if (create) {
    // Created offline then deleted offline: the server never saw this event —
    // drop every queued op for it (child snapshots included) and store nothing.
    return { dropSeqs: mine.map((o) => o.seq), replaceSeq: null, op: null };
  }
  // The delete supersedes any queued edit AND any child snapshots (the server's
  // cascade wipes those tables with the event — flushing them after would only
  // park pointless conflicts).
  const superseded = mine.filter((o) => o.kind === "event.update" || isChildListOp(o));
  return {
    dropSeqs: superseded.map((o) => o.seq),
    replaceSeq: del ? del.seq : null,
    op: incoming,
  };
}

/**
 * Fill DB-default columns so an offline-created event renders through the same
 * components as a server row (lists, badges, detail header). `values` are exactly
 * the columns the queued INSERT will send; everything else takes the DB's default.
 */
export function materializeEventRow(
  op: { id: string; values: Partial<EventRow> },
  nowIso: string
): EventRow {
  return {
    tenant_id: "",
    group_id: "",
    name: "",
    event_date: null,
    venue: null,
    event_type: "idol",
    show_start_time: null,
    hard_out_time: null,
    status: "draft",
    notes: null,
    map_url: null,
    costume_theme: null,
    share_token: null,
    share_expires_at: null,
    deadline: null,
    deadline_note: null,
    last_run_seconds: null,
    last_run_at: null,
    is_template: false,
    is_practice: false,
    created_by: null,
    created_at: nowIso,
    updated_at: nowIso,
    ...op.values,
    id: op.id,
  } as EventRow;
}

const CHILD_LABELS: Record<ChildListKind, string> = {
  "setlist.upsert": "เซ็ตลิสต์",
  "schedule.upsert": "ตารางเวลา",
  "mic.upsert": "ผังไมค์",
  "lineup.upsert": "รายชื่อขึ้นโชว์",
};

/** Thai one-liner for a queued/parked op (status chip + conflict list). */
export function describeOp(op: NewMgmtOp): string {
  if (isAudioUploadOp(op)) {
    const title = op.songTitle?.trim();
    return `อัปไฟล์เสียงของ${title ? `เพลง “${title}”` : `เพลง #${op.id.slice(0, 8)}`}`;
  }
  const name = isChildListOp(op)
    ? op.eventName
    : op.kind === "event.create"
      ? op.values.name
      : op.kind === "event.update"
        ? op.patch.name
        : null;
  const label =
    typeof name === "string" && name.trim() ? `“${name.trim()}”` : `งาน #${op.id.slice(0, 8)}`;
  if (isChildListOp(op)) return `แก้${CHILD_LABELS[op.kind]}ของ${label}`;
  if (op.kind === "event.create") return `สร้าง${label}`;
  if (op.kind === "event.update") return `แก้ไข${label}`;
  return `ลบ${label}`;
}

/**
 * Is this write failure a NETWORK failure (queue it and sync later) rather than a
 * real rejection (RLS / validation / constraint — surface it, never queue)?
 * supabase-js doesn't throw on network loss; it resolves with an error whose
 * message wraps the fetch failure, so we classify by message. `onLine` false is
 * always queueable (navigator already knows we're offline).
 *
 * ── 🔴 WHY IT ALSO TAKES AN HTTP STATUS NOW (round 10) ──────────────────────────
 * Reading the PROSE was never the contract, only the best evidence available at the
 * call sites of the day — and it has one blind spot that is exactly the wrong shape:
 * **the server is up and answering badly.** A Supabase or Cloudflare 503 / 502 / 429
 * comes back as an HTML error page, and postgrest-js puts that page into
 * `error.message` verbatim (dist/index.cjs:420-432). "Service Unavailable", "Bad
 * Gateway" and "Too Many Requests" match none of the words below, so the write was
 * classified as a REAL REJECTION: not written, not queued, gone.
 *
 * On the festival board that is the operator's "จบ + ต่อไป" press disappearing while
 * the row is already optimistically advanced — their screen says band B is on, every
 * other device still says band A. And because `next()` is TWO writes, an outage that
 * catches one of them can leave two rows holding `status='live'` on a board the whole
 * label is watching. **A fully offline press was handled perfectly; a sick server was
 * handled worse than no server at all.**
 *
 * The `status` on a PostgrestResponse answers this exactly and no other code in the
 * repo was reading it. Pass it wherever you have it.
 *
 * 🔒 WHAT DELIBERATELY DID NOT CHANGE: 401/403 are still real rejections — and note that
 * this is not a NEW rule, it is the old behaviour written down. The message regex never
 * matched "permission denied" or "JWT expired" either, so nothing about a 4xx moved when
 * the status was threaded in; only 5xx/429 changed hands.
 *
 * ⚠️ AN OPEN QUESTION THE NEXT ROUND SHOULD SETTLE, because two files in this repo
 * disagree about it. `lib/auth-session.ts` states that the anon-fallback window produces
 * "an empty result and no error at all", which is what the whole "an empty read is not an
 * empty table" class was built on. But every table grant in `supabase/migrations/0001` is
 * `to authenticated` ONLY, and if `anon` truly holds no privilege on these tables then that
 * window yields a permission denial (42501 → HTTP 403), not a silent empty read — in which
 * case a write attempted in that minute would be classified here as a real rejection and
 * DISCARDED rather than queued.
 *
 * It is left alone on purpose rather than guessed at: flipping 403 to queueable would make
 * a genuine permission denial replay on every reconnect forever, and the observable
 * behaviour today is unchanged from before this round either way. **Settle it by observing
 * a real anon-window write against production, not by reading the migrations** — Supabase
 * projects have carried different default privileges over time, which is exactly why 0002's
 * own comment says "newer Supabase projects don't auto-grant".
 *
 * When no status is available (an older caller, or a transport failure that never got
 * a response) the message rules still decide, exactly as before.
 */
export function isQueueableWriteError(
  message: string | null | undefined,
  onLine: boolean,
  status?: number | null
): boolean {
  if (!onLine) return true;
  // A status of 0 means "no response at all" — that is a transport failure, and the
  // message rules below already recognise it. Only a real HTTP code decides here.
  if (typeof status === "number" && status > 0) {
    // Transient by definition: the request was understood and the server asked to be
    // asked again. 408 request timeout · 425 too early · 429 rate limited · 5xx.
    if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
    // Any other 4xx is the server telling us this write is not acceptable. Queueing it
    // would mean replaying a rejection on every reconnect, forever.
    if (status >= 400) return false;
  }
  if (!message) return false;
  return /failed to fetch|fetch failed|load failed|network|err_internet|err_network|err_connection|timed? ?out|abort/i.test(
    message
  );
}

/** Client-minted uuid PK for an offline-created child row (same rules as events). */
export function newLocalRowId(): string {
  return newEventId();
}

/** Client-minted uuid PK for an offline-created event (stable id, no remap). */
export function newEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for any runtime without crypto.randomUUID (kept uuid-shaped).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
