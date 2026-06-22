# CueIQ — แผนทดสอบฉบับสมบูรณ์ (Definitive QA Runbook)

ทดสอบทุกปุ่ม/ฟังก์ชัน/โรล บน **prod** `https://cueiq-mu.vercel.app` ผ่าน **Claude in Chrome**
เป้าหมาย: จบจริงๆ ครั้งเดียว. **ห้ามแตะข้อมูลจริง** — สร้าง/ลบเฉพาะของทิ้งที่ชื่อขึ้นต้น `ZZ ` เท่านั้น.

> รหัสบัญชีทั้ง 19 → memory `cueiq-credentials`. Baseline ปัจจุบัน: **8 templates + 5 real events + 1 practice**, 9 songs, 19 users, 8 bands.

---

## Phase 0 — Setup & กลไกการขับ Chrome
- [ ] `list_connected_browsers` → ใช้ "Browser 1" (local).
- [ ] บันทึก baseline จาก DB (Mgmt-API, `SUPABASE_ACCESS_TOKEN` ใน `.env.local`): นับ events ตามชนิด, songs, users, bands. เก็บไว้เทียบตอนจบ.
- **กลไก (สำคัญ — เรียนรู้มาแล้ว):**
  - Chrome autofill ยัด "Architect" ลงช่อง username → **ใช้ `form_input` (DOM) เซ็ตค่า อย่าพิมพ์ด้วยคีย์บอร์ด**.
  - ฟอร์ม login refs นิ่ง: `ref_8`(user)/`ref_10`(pass)/`ref_11`(submit) — แต่ต้อง `find` ใหม่ทุกครั้งหลัง navigate.
  - logout ≈ พิกัด (1011, 11).
  - toast "เข้าสู่ระบบ" สีเขียวบังป้ายบทบาทชั่วครู่ → re-navigate /dashboard แล้ว zoom อ่านป้าย.
  - หลังกดสร้าง/ลบ ให้ navigate ใหม่เพื่อล้าง toast ก่อนอ่านผล.

---

## Phase 1 — Admin (`architect`) — surface กว้างสุด ทำของหนักที่นี่
ป้าย=Admin, เมนูครบ (Events/Overview/Library/Training/Artists/Admin).

### 1A. New Event เต็มรูปแบบ (ของทิ้ง — สร้างใน **Seishin** เพราะมีเพลง+เสียงในคลัง)
- [ ] New Event → ชื่อ `ZZ FULL EVENT` → วง Seishin → event_type idol → กรอก วันที่/สถานที่/show_start/hard_out → **บันทึก** → เปิดงาน.
- [ ] **Setlist + Run Time**: เพิ่มเพลงจากคลัง (เลือกเพลง Seishin ที่มีเสียง) ≥2 เพลง → เรียง ▲▼/ลาก → ตั้ง buffer/notes → toggle loop → ตั้ง mic slots. _ผล: running time รวมอัปเดต, บันทึกติด._
- [ ] **ตั้งค่างาน**: แก้ venue/show times/costume_theme/map. 
- [ ] **Mic Map**: กำหนดไมค์ครบ. _ผล: completeness panel "ยังขาด…" ลดลงเรื่อยๆ._
- [ ] เติมจนครบ → **สถานะเด้ง draft → pending_review อัตโนมัติ** (completeness gate). _ตรวจ: approver ได้ notification._
- [ ] **Approval**: อนุมัติ → approved → งานถูกล็อก (read-only) → กด "แก้ไข (กลับไปรออนุมัติ)" → revert เป็น pending_review.
- [ ] **Export**: Export Excel ↓, บันทึกเป็นรูป JPG ↓, พิมพ์/PDF ↓. _ผล: ไฟล์ออกถูกต้อง._
- [ ] **แชร์**: สร้าง share link → เปิดในแท็บใหม่ (ไม่ login) → หน้า /share เรนเดอร์ run sheet (anon RPC).

### 1B. Live Mode (บนงาน ZZ FULL EVENT — มีเสียงจริง)
- [ ] เริ่ม Live Mode → **START** เพลงแรก → currentTime เดิน, เสียงเล่นจาก R2.
- [ ] **NEXT** / cue แถว, **Auto** ↔ **Manual** สลับ (Auto resume เพลงที่กำลังดัง ไม่ใช่แถวที่ cue), **seek**, **volume**, **goto-cue**, คีย์ลัด (Space/←→).
- [ ] นับถอยหลัง + overtime, **reset** (มี dialog ยืนยัน), autoplay-resume banner ถ้าโดนบล็อก.
- [ ] **จบโชว์** → บันทึก last-run. _ตรวจ: การ์ดงานโชว์ "โชว์ล่าสุดใช้เวลา …"._

### 1C. Duplicate + Delete + Create-from-template
- [ ] Duplicate `ZZ FULL EVENT` → `ZZ FULL EVENT (สำเนา)` (คัดลอกคิว/เซ็ต/ไมค์ ไม่รวมเสียง) → **ลบสำเนา** (การ์ดหายทันที — optimistic).
- [ ] สร้างจากแม่แบบ → เลือกวงอื่น (เช่น KŌMA) → ได้เซ็ต **generic "เพลงตัวอย่าง"** ไม่ใช่เซชิน → **ลบ**.

### 1D. Library
- [ ] อัปโหลดเพลงทิ้ง `ZZ TEST SONG` (ไฟล์เสียงเล็ก ขึ้น R2) → แก้ชื่อ/หมวด → copyright triage (cleared→rejected) → เล่นตัวอย่าง → **ลบ** (เคลียร์ R2). _ห้ามแตะ 9 เพลงจริง._

### 1E. Admin tools (`/admin`)
- [ ] สร้างบัญชีทิ้ง `zz-tester` (member ของวงใดวงหนึ่ง) → ขึ้นในลิสต์ → ค้นหาเจอ → 🔑 reset password → แก้ role → **ลบ** (0 orphan).
- [ ] ยืนยัน Architect มี 🔒 Master + ไม่มีปุ่มลบ.
- [ ] R2 storage gauge แสดงผล. DevInbox: ส่ง feedback ทิ้ง → เห็นใน inbox → ลบ.
- [ ] ทีมงานประจำค่าย: เพิ่ม staff `ZZ STAFF` → ลบ.

### 1F. Groups / Artists + Overview + Global
- [ ] สร้างวงทิ้ง `ZZ BAND` → ตั้งสี/self_photo → เพิ่ม roster member → **ลบวง**.
- [ ] Overview: สลับ view ทั้ง 5 (รายวัน/รายงาน/สัปดาห์/เดือน/ปี) + ฟิลเตอร์วัน/วง/สถานะ → แก้ photo-time → บันทึกเป็นรูป (เห็นบล็อก ทีมงาน/ติดต่อ).
- [ ] Header: theme toggle, fullscreen/kiosk, PWA "ติดตั้งแอป", FeedbackButton, bell (เปิด push = ต้องมือถือ → ข้าม/ทำฝั่ง user).

---

## Phase 2 — Ar (`seishin-ar`)  _(ใช้เซชินเพราะมีเสียงในคลัง)_
- [ ] ป้าย=Ar; เมนูไม่มี Overview/Admin; เห็นเฉพาะงานเซชิน.
- [ ] สร้าง/แก้งานของวงตัวเอง (setlist/schedule/mic) ได้; เพิ่มเพลงจากคลังเซชิน.
- [ ] **Submit for approval** ได้ แต่ **อนุมัติเองไม่ได้** (ไม่มีปุ่ม approve).
- [ ] **Live Mode = เล่นได้ แต่แก้ real-time ไม่ได้ + ไม่มี "จบโชว์"** (admin-only). ยืนยันปุ่มแก้/จบโชว์หาย.
- [ ] Library: เพิ่ม/แก้เพลงวงตัวเองได้ แต่ **copyright badge กดไม่ได้** (ไม่ใช่ approver).
- [ ] Groups: แก้ roster วงตัวเองได้ แต่ **สร้าง/ลบวง + ตั้งค่าวงไม่ได้** (admin-only).
- [ ] cross-band: เปิด/แก้งานวงอื่นไม่ได้ (มองไม่เห็น).
- [ ] สร้างจากแม่แบบ (วงตัวเอง) → generic → ลบ.

---

## Phase 3 — Member (`seishin-mem`)
- [ ] ป้าย=สมาชิก; เมนูไม่มี Overview/Admin; เห็นเฉพาะวงตัวเอง.
- [ ] **อ่านอย่างเดียว**: ไม่มี New Event / สร้างจากแม่แบบ / duplicate / delete / ปุ่มแก้.
- [ ] เปิดงานเซชิน → read-only (ไม่มีลิงก์แก้/แชร์).
- [ ] Live Mode → เล่น/ฟังได้ (ซ้อม) แต่ **ไม่มีปุ่มแก้/จบโชว์** + แบนเนอร์ "โหมดซ้อม".

---

## Phase 4 — CEO (`ceo`)
- [ ] ป้าย=CEO; เห็นทุกวง (5 งาน); **สร้าง/แก้ไม่ได้** (observer); Overview มี, Admin ไม่มี.
- [ ] เปิดงาน → read-only; Live → ดูอย่างเดียว.

---

## Phase 5 — Label Staff (`label-staff`)
- [ ] ป้าย=Label; /dashboard **เด้งไป /overview**; เปิด /events/[id] **เด้งกลับ /overview**.
- [ ] Overview: **อนุมัติ/ปฏิเสธ** งานทิ้งที่ Ar ส่งมา (ทำบนของทิ้ง); แก้ **photo-time** ของวง self_photo=off.
- [ ] Library: copyright badge **กดได้** (approver) แต่ **เพิ่ม/แก้เพลงไม่ได้**.
- [ ] Live จาก overview = ดูอย่างเดียว.

---

## Phase 6 — Cleanup & Sign-off
- [ ] ลบของทิ้งทั้งหมด: events `ZZ %`, song `ZZ TEST SONG` (+R2 object), user `zz-tester`, band `ZZ BAND`, staff `ZZ STAFF`, feedback ทิ้ง.
- [ ] DB query → **กลับ baseline**: 8 templates + 5 real + 1 practice, 9 songs, 19 users, 8 bands, **ไม่มี `ZZ %`**, 0 orphan ใน auth.users/profiles/group_roles.
- [ ] R2 → ไม่มี object `ZZ`. Guard triggers (`events_guard_update`/`songs_guard_update`) = enabled.
- [ ] Logout. สรุปผลเป็นตาราง: ปุ่ม/ฟังก์ชัน × โรล = ✅/❌ + บั๊กที่เจอ.

---

## หมายเหตุ: สิ่งที่เบราว์เซอร์เทสไม่ครบ (ฝั่ง user / อุปกรณ์จริง)
- Web Push จริง (ต้องมือถือเปิด permission + ยิง test push), iOS Safari audio/AudioContext.
- PWA install จริงบน Android/iOS.
- Multi-device Live sync บน Wi-Fi งานจริง (จำลองได้ด้วย 2 แท็บ: START/NEXT sync + take-control).
- เน็ตหลุดกลางเพลง → เล่นจาก cache (offline).
