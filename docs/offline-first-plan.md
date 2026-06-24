# CueIQ — Offline-First (Local-First) Plan

> สถานะ: **§11-B + P1 SHIPPED** (2026-06-25) — preflight readiness + offline cold-boot deployed to prod.
> ⏳ รอพี่ test airplane-mode จริงบนเครื่องก่อนพึ่งพา · **P2 = next, ต้อง confirm scope (น่าจะมี DB migration + ต้อง 2-device test)**
> ต่อยอดจาก Single Audio Source (`511a26a`) + offline suite ที่มีอยู่
>
> **Done so far:**
> - §11-B `b1846d8` — Show Readiness Check preflight (lib/show-readiness.ts + components/event/show-readiness-check.tsx on the live page): songs-on-device · storage pinned · free space · battery · net, with inline prep/pin actions.
> - P1 `829be48` — offline cold-boot: lib/event-store.ts (IndexedDB show-data snapshot) + EventSnapshotWriter (live page persists it) + app/live-shell + live-shell-client (static shell reads snapshot → mounts Live Mode) + sw.js v5 (precache shell, serve it for uncached offline /events/<id>/live). Online path untouched. Verified on prod: /live-shell 200, sw.js v5.

## 1. เป้าหมาย
- เปิดแอปใช้งานได้ตั้งแต่แรกแม้ไม่มีเน็ต (offline boot)
- **เครื่องเดียวรันโชว์ครบ 100% standalone** — worst case ไม่มีเน็ตทั้งงาน (เกิดยาก แต่ต้องรองรับ)
- **ออฟไลน์ = source of truth ของงานหน้างาน**; cloud sync ตามทีหลังตอนมีเน็ต (intermittent)
- เสียงห้ามพลาดแม้นิดเดียว (zero-tolerance) — สืบต่อจาก Single Audio Source

## 2. สถานะปัจจุบัน (มีแล้ว — อย่าสร้างซ้ำ)
- **เสียงออฟไลน์**: blob ใน IndexedDB — `lib/song-cache.ts` (key by R2 path) + `lib/audio-store.ts` (per-event `eventId::itemId`). Live/Practice เล่นจาก blob → ไม่พึ่ง presigned URL
- **prefetch**: `components/event/{library-prefetch,auto-prefetch}.tsx`, `lib/audio-prefetch.ts`; จัดการพื้นที่ `components/event/device-storage.tsx`
- **service worker** `public/sw.js` (v4): app shell + หน้า (network-first → cached render) + count sounds; **ไม่แตะ Supabase** (auth/realtime/storage)
- `components/offline-banner.tsx`, crash snapshot ของ live state ใน localStorage
- **Single Audio Source** (`live-mode.tsx`): เครื่องเสียงเป็นเจ้าของ playback position; viewer ตามแค่ discrete (track + play/pause)

## 3. Roles / Authority
| บทบาท | กลไก | Override |
|---|---|---|
| **Audio Host** (เปิดเพลงของวง) | **device-lock** (ใครก็เป็นได้ + lock กันแย่ง) — เผื่อน้องซ้อมเอง | ยศสูงกว่า force-แย่งได้ (admin แก้ member ลืมปิด) |
| **Show Main** (จับเวลา/จด/log การรันโชว์) | **device-claim** (เครื่องแรกที่กด "เริ่มโชว์" ของวันนั้น = เมน) | โอนปกติ = push (ยกให้); ยศสูงกว่า = force-override |

ลำดับยศ (จาก [[cueiq-rbac-spec]]): Master Admin > CEO > Label-Staff > Ar (artist_manager) > Member (per-band)

## 4. Transport (เครื่องคุยกันยังไง)
- **ปกติ (intermittent net):** cloud เป็นตัวกลาง — sync/hand-off ทำตอนมีเน็ต = ตรงไปตรงมา
- **standalone (no net ทั้งงาน):** เครื่องเดียวรันครบ ไม่พึ่งเน็ต; การคุยข้ามเครื่องแบบ offline ล้วน (peer: same-LAN / QR / ไฟล์) = **Phase ท้าย** (เกิดยาก, ทำทีหลัง)

## 5. Conflict resolution (แยกโซน)
| โซน | ใครชนะ | กติกา |
|---|---|---|
| **เวอร์ชันเพลง** (ไฟล์เสียง) | **offline ชนะได้** | **newer-upload-wins** (timestamp ใหม่กว่าชนะ) — รองรับวิ่งเอา flash drive/AirDrop เข้าเครื่องเมน → stamp เวลา → cloud ลบเก่าเอาใหม่ตาม |
| **show-run** (เวลาจริง/late-early/จด/สถานะ run) | **offline / main ชนะ** | main authority = คนหน้างานคือความจริง |
| **master / stage / booth** (ผังเวที, ข้อมูลจัดการ, user, library meta, copyright) | **online ชนะ** | คนแก้ควรเป็นฝั่งออนไลน์ |
- เก็บ version ที่ถูกทับไว้กู้เสมอ (กันข้อมูลหาย)

## 6. Hand-off & Override flow
- **Normal hand-off (push):** เมนปัจจุบันกด "โอนให้เครื่อง X" → X รับ data ล่าสุด + กลายเป็นเมน → เครื่องเดิมถอย. **ไม่มีเครื่องไหน claim เองได้**
- **Rank override (force):** user/เครื่องที่ยศ "สูงกว่า" คนที่ถืออยู่ → ปุ่ม "เข้าควบคุม (force)" → ยืนยันชัด → ปล้น lock/main + แจ้งเครื่องเดิม. ใช้ได้ทั้ง Audio Host + Show Main
- **เมนหายไม่ทันโอน** (เครื่องพังกลางโชว์): ไม่มี auto-steal → ใช้ rank override (break-glass). ปกติคาดหวังว่า "เห็นแบตจะหมด = เตรียมโอนก่อน"

## 7. Data model — สิ่งที่ต้องเพิ่ม
- `deviceId` — สุ่มต่อเครื่อง เก็บ localStorage
- **show-run authority** marker: `(eventId|date)` → `{ mainDeviceId, claimedAt, byUserRole }`
- **audio-host lock**: `(eventId|groupId)` → `{ hostDeviceId, lockedAt, byUserRole }`
- เพลง: `updated_at`/`uploaded_at` (path มี version suffix อยู่แล้ว — เพิ่ม timestamp สำหรับ newer-wins)
- **sync outbox** (IndexedDB): คิวของ local changes (show-run log, song upload) + สถานะ (pending/synced/conflict)
- ป้าย "zone" ต่อ entity (show-run vs master) เพื่อรู้ทิศ conflict

## 8. Phases (ต่อยอด ไม่ rewrite)
- **P1 — Offline boot + read (เล็ก):** ปรับ SW ให้ boot ได้แน่ + pull event/setlist ลง IndexedDB + ให้ live page อ่าน **local-first** → เปิดโชว์ออฟไลน์ได้แม้ไม่เคยเปิด; **single-device standalone รันครบ**
- **P2 — Local authority + write (กลาง):** `deviceId`; Show Main claim + push hand-off; Audio Host lock; show-run เขียนลง local outbox; sync ขึ้น cloud (main-wins) ตอนมีเน็ต
- **P3 — Override + song-version sync + zones:** rank override (force); newer-upload-wins สำหรับเพลง (รวม import flash/AirDrop เข้าเครื่องเมน → stamp → cloud ตาม); แยกโซน show-run vs master + เก็บ version กู้
- **P4 (optional, เกิดยาก):** peer transport สำหรับ no-net hand-off (same-LAN / QR / export-import)

## 9. Edge cases / Risks
- **Clock skew** (เครื่องออฟไลน์เวลาเพี้ยน → timestamp มั่ว): ใช้ hybrid/logical clock หรือ re-stamp ด้วยเวลา server ตอน sync; "newer-wins" อิง monotonic ของเครื่องเมน
- **master vs show-run zone** ต้องแยกชัด ไม่งั้นเครื่องหน้างานทับ master โดยไม่ตั้งใจ
- **song newer-wins**: กันลบไฟล์ที่ยังถูกใช้ (เก็บ version เก่าไว้กู้)
- **standalone resume**: crash snapshot ของ live state ต้องครบพอ resume โชว์หลังแอปปิด/รีโหลด
- **realtime หลายเครื่อง = ต้องมีเน็ต** (Supabase channels) → ออฟไลน์ = เครื่องเดียว (เข้าทาง Single Audio Source)

## 10. Decisions log (เคาะ 2026-06-25)
1. Audio Host = **device-lock** (ไม่ใช่ band-main user) — เผื่อน้องซ้อมเอง
2. Show Main = **device-claim + push hand-off**; **ยศสูงกว่า force-override** ได้
3. Conflict: เพลง = offline **newer-upload-wins** · show-run = offline wins · master/stage = online wins
4. เน็ต = intermittent ปกติ + ต้อง **standalone** เผื่อ no-net ทั้งงาน
5. เมนหาย = **ไม่ auto-steal**; ยศสูงกว่าปล้น (break-glass)

## 11. เพิ่มเติมที่ต้องคิด — backlog (brainstorm 2026-06-25)
แกน design (§3–6) แน่นแล้ว; ส่วนนี้คือ "กันพลาดหน้างาน" ที่มักโผล่ตอนใช้จริง

### A. เสียงห้ามพลาด (ต่อยอด zero-tolerance)
- ⚠️ **iOS silent switch / audio session** — ถ้าเครื่องเสียง = iPhone: ปุ่มเงียบข้างเครื่อง หรือ Safari background = เสียงหายเงียบ ๆ. ใช้ **Web Audio API** (AudioContext) ไม่ใช่แค่ `<audio>`, ตั้ง audio session = "playback", `playsinline`, ปลุก AudioContext ด้วย user gesture, เตือนถ้า silent
- **Audio output device หลุด** (Bluetooth/USB interface): ฟัง `devicechange` → pause + เตือน ไม่ใช่เด้งออกลำโพงในตัว
- **Resume หลัง crash/standalone reload**: tap-to-resume ชัด (มี `resumeAudio` แล้ว — ขยายให้ครอบ standalone restore)
- **Thermal/battery throttle**: เล่นนาน ๆ timing อาจเพี้ยน — เฝ้าระวัง

### B. เพลงต้องอยู่ครบจริง (storage)
- ⚠️ **`navigator.storage.persist()`** — iOS/บราว์เซอร์ evict IndexedDB ได้ (พื้นที่ต่ำ/ไม่ใช้นาน) → เพลงหายก่อนงาน! ขอ persistent storage + แสดงสถานะ persisted
- **Storage quota เต็ม** → จัดการ + เตือนตอน prefetch (`navigator.storage.estimate()`)
- **Preflight "Show Readiness Check"** ก่อนเริ่มโชว์: เพลงครบทุกเซ็ต? · พื้นที่พอ? · persisted? · เครื่องนี้เป็น main? · แบตพอ? · net? → checklist เขียว/แดง

### C. อย่าหลุด/เด้งกลางงาน
- **Auth token refresh**: Supabase JWT หมดอายุระหว่าง offline นาน → พอ online refresh เงียบ ๆ **อย่า logout** (เสียงานหน้างาน)
- **Main claim TTL + ghost main**: เครื่อง main หายไปเลย → marker ค้าง → เครื่องอื่น force override ได้ (มีใน design) + heartbeat/TTL
- **Race**: 2 เครื่อง claim main ตอนต่าง offline → online พร้อมกัน → tiebreak (claimedAt + rank)

### D. มองเห็น/กู้ได้ (UX หน้างาน)
- **Status indicator เด่น**: เครื่องนี้ MAIN? · online/offline · sync ค้างกี่รายการ · เพลงครบ — บนจอ live ชัด ๆ
- **"เครื่องนี้คือ MAIN" เด่นมาก** กันหยิบผิดเครื่อง
- **Crash recovery**: เปิดใหม่ → resume ตำแหน่ง + คงสถานะ main + เพลงเล่นต่อ

### E. Sync ทน
- **Idempotent + retry + resume** (เน็ตหลุดกลาง push)
- **ลำดับ sync**: song upload เสร็จก่อน setlist ที่อ้างถึง; outbox จัดลำดับ/ขึ้นทีละชิ้น
- **Presigned UPLOAD URL** ขอใหม่ตอน sync (expiry)

### F. ความปลอดภัย / อื่น ๆ
- **เครื่องหาย/ขโมย** → data+เพลงใน IndexedDB ไม่ encrypt → policy: logout = clear? ระดับ sensitive แค่ไหน
- **Multi-band งานเดียว** (event run-order `run_sequence`): หลาย audio host + show main ร่วม → sync หลาย authority ในงานเดียว
- **Practice Mode**: offline ครอบด้วย (เพลงอยู่ใน song-cache แล้ว) — ตรวจให้ครบ
- **Rollout**: feature-flag/ทยอยเปิดบน prod ที่ใช้จริง + ไม่ทำ data เดิมพัง + test checklist (2 เครื่อง + ปิดเน็ตจริง)

## 12. เริ่มยังไง (สำหรับ session ใหม่)
1. อ่าน doc นี้ + memory `cueiq-offline-first-plan`
2. ~~§11-B~~ **DONE `b1846d8`** — `storage.persist()` (มี global ใน sw-register อยู่แล้ว) + preflight readiness (ShowReadinessCheck บน live page)
3. ~~P1~~ **DONE `829be48`** — event-store snapshot + EventSnapshotWriter + live-shell + sw.js v5. (a)(b)(c) ครบ. **(d) ทดสอบ single-device standalone ปิดเน็ตจริง = รอพี่ test airplane-mode** (โหลด live page online 1 ครั้งให้ snapshot+audio ลงเครื่อง → ปิดเน็ต → เปิด live ใหม่ → ต้องบูตจาก shell ได้)
4. **NEXT = P2** (Local authority + write): `deviceId` · Show Main claim + push hand-off · Audio Host lock · show-run local outbox · sync (main-wins). **confirm scope กับพี่ก่อน** + น่าจะมี **DB migration** (= confirm-first) + ต้อง **2-device test**. แล้ว P3 ตาม §8
5. อย่าลืม: เสียง = zero-tolerance, อย่า hot-build, ทดสอบ 2 เครื่องจริงก่อน deploy
