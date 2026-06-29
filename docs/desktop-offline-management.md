# Desktop Offline MANAGEMENT — write path (⭐#1 step 2)

> สถานะ: **DESIGN — ready to build, GATED.** Step 1 (read-cache) shipped `af36d7f`
> (`desktop/src/data/cache.ts` + workspace/event-bundle/events-list loaders
> write-through online, fall back to cache offline). Step 2 below is the WRITE
> half: create/edit management data offline and sync on reconnect.
>
> ⛔ **GATE — do NOT start coding until พี่ confirms the read-cache works on the
> real `.exe`** (open online once → airplane → reopen → dashboard + cached events +
> amber offline banner; open a cached event → detail shows). Step 2 overlays on the
> read-cache; if the cache foundation is shaky on the packaged app, build that first.
>
> Pairs with [docs/offline-first-plan.md](offline-first-plan.md) (the web show-run
> outbox + conflict zones) and reuses the proven pattern in
> [lib/show-run-outbox.ts](../lib/show-run-outbox.ts).

## 1. เป้าหมาย / สิ่งที่ขาด
Today the desktop reuses the web write-components (`EventForm`, setlist/schedule/
mic/lineup editors), which call Supabase **directly**. Offline, those writes throw
and the change is lost. We want: **create + edit management data offline → it shows
immediately → it syncs to cloud on reconnect.**

In scope (the "master / stage" zone — see §5 of the offline-first plan):
- **Create event** (`EventForm` mode=new) — the highest-value offline case (plan a
  show on a plane).
- **Edit event metadata** (`EventForm` mode=edit).
- **Setlist / schedule / mic-map / lineup** edits on a cached event.

Out of scope here (handled elsewhere or deferred):
- Show-run data (last-run time, live authority) — already offline via
  `show-run-outbox` + `show-authority` (the "offline/main wins" zone).
- **Song AUDIO upload** offline — bytes are large + need a presigned PUT; defer to a
  later pass (queue the metadata row, mark audio "pending upload", flush bytes when
  online). Note in UI: offline you can reference a song but not push new master audio.

## 2. กติกา conflict (ย้ำจาก §5)
Management data is the **"online wins"** zone: the person editing master/stage data
should normally be the online one. So an offline management edit is a *low-priority*
write — on flush it must **not blindly clobber** a newer server change. Always keep
the overwritten value to recover (no silent data loss).

## 3. สถาปัตยกรรม (3 ชิ้น)

### 3a. `desktop/src/data/outbox.ts` — durable op queue
Mirror `lib/show-run-outbox.ts` exactly (IndexedDB `cueiq-mgmt-outbox`, store `ops`,
best-effort, `pendingCount`, `flushOutbox`) but with a richer op set and an explicit
**monotonic `seq`** key (not last-value-per-datum) so a create-then-three-edits
replays **in order**. Op shape:

```ts
type MgmtOp =
  | { kind: "event.create"; row: EventInsert }       // row.id = client uuid (see 3c)
  | { kind: "event.update"; id: string; patch: Partial<EventRow>; base: number }
  | { kind: "setlist.upsert"; eventId: string; items: SetlistItem[]; base: number }
  | { kind: "schedule.upsert"; eventId: string; items: ScheduleItem[]; base: number }
  | { kind: "mic.upsert"; eventId: string; rows: MicAssignment[]; base: number }
  | { kind: "lineup.upsert"; eventId: string; memberIds: string[]; base: number };
// `base` = updated_at (epoch ms) of the row this edit was made against → lets flush
// detect "server changed under me" for the online-wins zone (§4).
```
Each queued record: `{ op, seq, queuedAt }`, `seq` from a counter in the same store.

### 3b. Loaders overlay the outbox (so offline writes are VISIBLE)
Read-cache shows last-known *server* data; pending ops are not in it yet. Without a
merge, an offline-created event "saves but can't be opened" (the exact trap that
killed the earlier naive attempt — see memory `cueiq-handoff` 2026-06-27 "OFFLINE-
CREATE assessment"). So extend the step-1 loaders:
- `events-list.ts` → after building the list (cache or live), **apply pending
  `event.create` / `event.update` ops** on top.
- `event-bundle.ts` → after loading a bundle, apply pending ops for that `eventId`
  (metadata patch + setlist/schedule/mic/lineup upserts).
- A tiny `applyPending(data, ops)` pure helper → **unit-testable** (add to the vitest
  suite: a create shows in the list, an update patches a cached row, ordering holds).

### 3c. Client-minted UUIDs (no temp-id remap)
Offline `event.create` mints `crypto.randomUUID()` for the PK **now** and inserts
with that explicit id on flush. Children reference that same uuid immediately, so
there is **never** a temp→real id remap. Postgres `events.id` is a uuid default —
inserting an explicit id is allowed. Verify RLS allows client-supplied id (it does:
policies gate on tenant/role, not on id origin).

## 4. Flush (reconnect) — ordered + online-wins guard
On reconnect (the existing `OutboxFlusher` / online event already wired in the web
`(app)` layout; add the desktop equivalent in `shell.tsx`):
1. Replay ops by ascending `seq` (parents before children — a `event.create` always
   precedes its child upserts because it was queued first).
2. **Idempotent**: `event.create` → `upsert` on id (re-running a half-flushed queue
   is safe); child upserts are upserts on their natural keys.
3. **Online-wins guard** for `*.update` / `*.upsert`: before applying, read the
   server row's `updated_at`. If it is **newer than `op.base`**, the server changed
   while we were offline → **do NOT apply**; move the op to a `conflicts` store
   (kept for recovery / manual review) and surface a "N รายการชนกับเวอร์ชันออนไลน์"
   chip. `event.create` has no base → always applies.
4. Stop at the first hard network failure (still offline), leave the rest queued —
   same as `show-run-outbox.flushOutbox`.

## 5. UI
- Reuse `components/offline-banner.tsx` + the `live-status-strip` "pending sync"
  pattern → a "ค้างซิงค์ N" chip in the desktop shell header, plus a "ชนกัน N" chip
  when conflicts exist (click → list the parked writes, choose keep-mine / keep-server).
- The write-components need **no change**: wrap the supabase write call site in a
  `mgmtWrite()` helper (try online → on offline/throw, enqueue + optimistic-cache).
  Cleanest seam = a thin wrapper in `desktop/src/shims/` so the web stays untouched.

## 6. แผนสร้าง (incremental, each พี่-testable on the .exe)
1. `outbox.ts` (queue + `applyPending` pure helper) **+ vitest** for `applyPending`
   and the online-wins base check (pure logic, zero device needed).
2. Loader overlay (events-list + event-bundle) → offline create/edit **shows**.
3. `mgmtWrite()` seam + wire `EventForm` create/edit through it.
4. Flush + conflict store + status chips.
5. Setlist/schedule/mic/lineup ops.
6. (later) offline audio-upload queue.

⚠️ After every step: `cd desktop && npx tsc --noEmit` (root build excludes desktop),
and พี่ tests the rebuilt `.exe` (create offline → reopen → still there → reconnect →
appears on web). **Never ship a write-path step untested on a real packaged build —
the desktop runs live shows (zero-tolerance).**

## 7. Risks
- **Clock skew** on `base`/`updated_at` (offline device clock wrong) → prefer the
  server's `updated_at` as the authority; `base` is only "the value I last saw".
- **Partial flush** mid-reconnect → idempotent upserts + seq ordering make a re-run safe.
- **RLS rejects a queued op** (role changed) → treat as a conflict, don't drop silently.
- **Quota** (IndexedDB) → best-effort like the existing outbox; surface if it fails.
