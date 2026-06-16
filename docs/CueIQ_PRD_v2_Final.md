# CueIQ — Product Requirements Document v2.0 (Final)
**ผลิตภัณฑ์:** CueIQ — Show & Event Management Platform  
**Tagline:** Smart cues for every show.  
**เจ้าของ:** Capture Bomb Production  
**Go-to-market:** Idol & Artist (niche) → Live Music → Event Organizer (ขยายภายหลัง)  
**วันที่:** มิถุนายน 2026

---

## 0. สรุปกลยุทธ์ (อ่านก่อนสร้าง)

**หลักการสำคัญที่สุด:**
- **Architecture:** สร้างเป็น multi-tenant SaaS ตั้งแต่แรก รองรับทุกประเภท event โดยไม่ต้องรื้อ
- **Marketing:** เจาะ niche ไอดอล/ศิลปินก่อน — นี่คือจุดที่ไม่มีคู่แข่งทำ
- **Module System:** ฟีเจอร์เฉพาะวงการ (Mic Map, Costume, Booth, Guest) เป็น optional module ที่เปิด/ปิดได้ตามประเภทงาน
  - งานแต่ง/corporate → ปิด Mic Map, Costume, Booth
  - งานไอดอล → เปิดทั้งหมด

**ช่องว่างตลาดที่ยืนยันแล้ว:** ไม่มีแอปไหน (Shoflo, StageIQ, Setlistly) ทำ Run Sheet + Mic Map + Song Approval + Artist Scheduling สำหรับวงการ idol/T-pop/J-pop โดยเฉพาะ

---

## 1. Multi-Tenant Architecture (SaaS foundation)

```
Platform (CueIQ)
└── Tenant (ลูกค้า 1 ราย = ค่าย/บริษัท/ออร์แกไนเซอร์)
    ├── Subscription (แพ็กเกจ + billing)
    ├── Organization Settings (โลโก้, ธีม, ชื่อ)
    ├── Group (วง/ทีม/โปรเจกต์ภายใต้ tenant)
    │   ├── Song Library
    │   ├── Member + Mic Assignment
    │   └── Event
    │       ├── Schedule (+ optional modules)
    │       ├── Setlist
    │       ├── Crew List
    │       └── Version History
    └── Users (+ roles)
```

**Tenant Isolation:** ข้อมูลแต่ละ tenant แยกขาดจากกัน (Row-Level Security ใน Supabase) — ลูกค้า A เห็นข้อมูลตัวเองเท่านั้น

---

## 2. User Roles & Permissions

| Role | ขอบเขต | สิทธิ์ |
|---|---|---|
| **Platform Admin** | ทั้งระบบ | จัดการ tenant, billing, support (ทีม CueIQ) |
| **Tenant Owner** | 1 ค่าย | จัดการทุกอย่างในค่าย, ตั้งค่า billing, เพิ่ม/ลบวง |
| **Label Staff** | 1 ค่าย | ดู Overview ทุกวง, Approve/Reject เพลง, ตั้ง Deadline, แก้ Crew |
| **Artist Manager** | 1 วง | สร้าง/แก้ Event, Setlist, Schedule ของวงตัวเอง |
| **Sound Engineer** | Read-only | ดู Setlist + Mic Map + Buffer |
| **Lighting** | Read-only | ดู Setlist + Cue Notes |
| **General Staff** | Read-only | ดู Schedule |

---

## 3. Modules (เปิด/ปิดตามประเภทงาน)

**Core Modules (ทุกประเภทงานมี):**
- Event Info, Schedule, Setlist Builder, Run Time Calculator, Crew List, Export, Version History, Live Mode

**Optional Modules (toggle ตามประเภท):**
- Mic & Member Map
- Guest / Special Stage
- Costume Rounds
- Booth Rounds
- Photo Session
- Sound Check
- Song Approval

**Event Type Presets:**
| Preset | Module ที่เปิด |
|---|---|
| Idol / Artist | ทุก module |
| Live Band | Mic Map, Setlist, Sound Check |
| Wedding | Core เท่านั้น + Guest (เปลี่ยนชื่อเป็น "ลำดับพิธี") |
| Corporate | Core เท่านั้น |

---

## 4. Features (ครบทุกรายละเอียด)

### 4.1 Event Management
- ชื่องาน, วันที่, สถานที่, ประเภทงาน (เลือก preset), โน้ต
- Google Map: ค้นหา/ปักหมุด/ยืนยัน/แก้ไขโลเคชัน
- Pre-saved Locations: บันทึกสถานที่ที่ไปบ่อย (Lot of Live ฯลฯ) — ประหยัด Map API cost
- Multi-round รองรับหลายรอบใน 1 งาน

### 4.2 Schedule (นัดหมาย)
- On Location Time, Dressing Room, STB (Stand By)
- Photo Session (optional module — เฉพาะวงที่จัดงานเอง)
- Sound Check (optional — ข้ามได้, ระบุเวลา/คน/ไมค์)
- Costume Rounds (optional — เพิ่ม/ลบรอบ, ชื่อชุด, เวลา)
- Stage Rounds (เพิ่ม/ลบรอบ, เวลาเริ่ม-จบ)
- Booth Rounds (optional — เพิ่ม/ลบรอบ, ประเภท: บูธ/ไฮทัช/แฟนไซน์/อื่นๆ, สถานที่, เวลา)

### 4.3 Song Library
- เพิ่ม/แก้/ลบเพลงในคลังของวง
- ข้อมูล: ชื่อเพลง, ชื่อไฟล์, ความยาว (น:วิ), ภาษา, หมวดหมู่
- Audio Upload → detect ความยาวอัตโนมัติ → เก็บแค่ชื่อไฟล์+ความยาว (ไม่เก็บไฟล์จริง)
- Copyright Status: ถูกต้อง / รอตรวจ / ถูกปฏิเสธ

### 4.4 Setlist Builder
- Drag & Drop เรียงลำดับ
- เพิ่มรายการ: เลือกจากคลัง หรือสร้าง MC/SE/Interlude ใหม่
- ต่อรายการ: ชื่อ, เวลา (auto/manual), Buffer ก่อน (วิ), Buffer หลัง (วิ), Mic + สมาชิก + ลำดับ, Notes
- Auto-Calculate: Start/End/Accumulated/Hard Out status
- Hard Out Warning: เตือนทันทีถ้าเกิน

### 4.5 Mic & Member Map (optional)
- กำหนดไมค์เบอร์ → สมาชิก
- รองรับวนไมค์ (1 เบอร์ → หลายคน + ลำดับ)
- สรุป Mic Map แยกตามเพลง

### 4.6 Song Approval System (optional)
- Label Staff กด Approve / Reject แต่ละเพลง
- Reject ต้องระบุเหตุผล (เช่น "ลิขสิทธิ์ยังไม่อนุญาต")
- Artist Manager เห็น status + แก้ไขได้
- เพลงถูก reject = highlight แดง

### 4.7 Live Mode (หน้างาน)
- กด Start Show (sync กับ sound cue)
- Highlight บรรทัดปัจจุบัน + Countdown ต่อรายการ
- Accumulated Time + เวลานาฬิกาจริง
- Warning Zone: เหลือ 5 นาที = เหลือง / 2 นาที = แดง
- Next button (ข้ามรายการ)
- รองรับมือถือ + Realtime sync หลายเครื่อง

### 4.8 Deadline & Notification System ⭐ ใหม่
- **Label ตั้ง Deadline ต่อ Event + ต่อวง** (ยกเว้นวงที่ตั้งค่า exempt เช่น เซชิน)
- ข้อความเตือน custom ได้
- **Group Status:**
  | Status | ความหมาย |
  |---|---|
  | ⚪ Draft | ยังไม่เริ่มกรอก |
  | 🟡 In Progress | กรอกบางส่วน |
  | 🟠 Pending Review | ส่งแล้ว รออนุมัติ |
  | 🟢 Approved | ผ่าน พร้อมโชว์ |
  | 🔴 Rejected | มีเพลงถูกปฏิเสธ |
  | ⛔ Overdue | เกิน deadline |
- **แจ้งเตือน 3 ระดับ:** 72 ชม. (ปกติ) / 24 ชม. (ด่วน) / เกิน deadline (แจ้ง Label + lock setlist)
- Channel: In-app + Line Notify (ฟรี)

### 4.9 Version History
- บันทึกทุกการแก้ไข: วันเวลา / ผู้แก้ / สิ่งที่เปลี่ยน
- ดูย้อนหลัง + restore version เก่า

### 4.10 Share Links (Read-only)
- แยกตาม role: Sound Link / Light Link / Staff Link
- ตั้ง expiry date ได้

### 4.11 Export
- Excel (.xlsx) — หน้าตาตาม template ที่กำหนด (เหมือนตาราง Seishin v2)
- Google Drive Upload — กดปุ่มเดียว (connect Google ครั้งแรก)
- PDF — สำหรับพิมพ์/ส่ง Line

### 4.12 Label Overview Dashboard
- เห็นทุกวง: เวลา Stage/Booth/Photo, Status, Deadline
- Crew List รวม
- Approve/Reject จากหน้านี้
- Export ตารางรวมทุกวง

### 4.13 Branding
- โลโก้ CueIQ ทุกหน้า
- Tenant ใส่โลโก้ค่ายตัวเองได้ (white-label เบื้องต้น สำหรับแพ็กเกจสูง)

---

## 5. Pricing Tiers (SaaS)

| Plan | ราคา (เสนอ) | ขอบเขต |
|---|---|---|
| **Free** | 0 | 1 วง, 3 events/เดือน, ฟีเจอร์พื้นฐาน |
| **Pro** | 499 บ./เดือน | ไม่จำกัดวง, ทุก module, Export, Share Links |
| **Label** | 999 บ./เดือน | + Song Approval, Deadline System, Overview Dashboard, white-label |

*(ราคาปรับได้ตอน launch — เริ่มฟรีทั้งหมดช่วง beta)*

Payment: Stripe + PromptPay (รองรับคนไทย)

---

## 6. Tech Stack (ฟรี/ถูกที่สุด)

| Layer | Tech | หมายเหตุ |
|---|---|---|
| Frontend | Next.js 14 (PWA) | ใช้มือถือได้, add to home screen |
| Backend/DB | Supabase | Auth + Postgres + Realtime + Row-Level Security |
| Hosting | Vercel | Deploy อัตโนมัติจาก GitHub |
| Audio Detect | Web Audio API | Browser-side |
| Map | OpenStreetMap + Leaflet | ฟรี |
| Export | SheetJS (xlsx) | ฟรี |
| Drive | Google Drive API v3 | ฟรี |
| Notification | Line Notify API | ฟรี |
| Payment | Stripe + PromptPay | ตอนเปิดขาย |

---

## 7. Roadmap

### MVP (2-3 สัปดาห์ — ใช้กับ Seishin ได้จริง)
- Event + Schedule
- Setlist Builder + Auto-calculate
- Mic Map
- Export Excel
- Live Mode พื้นฐาน

### Phase 2 (หลังทดสอบงานจริง)
- Song Library + Audio Upload
- Drag & Drop
- Song Approval + Deadline System
- Share Links + Google Drive
- Version History
- Label Overview
- Multi-group

### Phase 3 (ขยายตลาด)
- Event Type Presets (Wedding, Corporate)
- Billing + Public Onboarding
- White-label เต็มรูปแบบ
- Line Notify integration

---

## 8. สิ่งที่น้องพัชร์ต้องทำต่อ

### ก่อนเริ่มสร้าง (Blocker)
- [ ] สมัคร GitHub, Supabase, Vercel, Google Cloud Console (ฟรี ~30 นาที)
- [ ] ซื้อ domain: `cueiq.app` หรือ `cueiq.com` (~300-500 บ./ปี)
- [ ] เตรียมโลโก้ (placeholder ใช้ตัวอักษร CueIQ ไปก่อนได้)

### เริ่มสร้าง
- [ ] เปิด Claude Code → แนบ PRD นี้ → "สร้าง CueIQ MVP ตาม PRD"
- [ ] ใช้ข้อมูล VANTAFLARE เป็น seed data ตัวแรก

### ทดสอบ
- [ ] กรอก Event จริง → ทดสอบ Live Mode ในงาน → feedback → ขยาย

---

## 9. หมายเหตุเรื่องทรัพย์สินทางปัญญา

- โค้ด + UI ได้ลิขสิทธิ์อัตโนมัติเมื่อสร้าง (ทั้งไทย + สากล)
- **ควรจดเครื่องหมายการค้า "CueIQ"** กับกรมทรัพย์สินทางปัญญา (~1,000-3,000 บ.) เพื่อป้องกันชื่อ
- ชื่อ CueIQ ตรวจแล้ว — ไม่ซ้ำในวงการ event/show software
- *ปรึกษาทนายทรัพย์สินทางปัญญาก่อนดำเนินการจริง (ข้อมูลนี้เป็นภาพรวมเบื้องต้นเท่านั้น)*
