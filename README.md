# CueIQ — Smart cues for every show.

Show & Event Management Platform สำหรับวงการ idol / artist (T-pop, J-pop) —
Run Sheet, Setlist + Run Time, Mic Map และ Live Mode ในแอปเดียว
สร้างโดย **Capture Bomb Production**

โปรเจกต์นี้คือ **MVP Phase 1** ตาม [PRD v2.0](docs/CueIQ_PRD_v2_Final.md)

---

## ✨ ฟีเจอร์ใน MVP Phase 1

| # | ฟีเจอร์ | รายละเอียด |
|---|---------|-----------|
| 1 | **Auth + Roles** | สมัคร/เข้าสู่ระบบ (Supabase Auth) + 7 บทบาท (Owner, Label, Manager, Sound, Light…) |
| 2 | **Event + Schedule** | สร้างงาน + ตารางนัดหมาย (On Location, STB, Sound Check, Stage, Booth, Photo…) |
| 3 | **Setlist Builder** | เพิ่ม/เรียง เพลง·MC·SE·Interlude + Buffer + **คำนวณ Run Time อัตโนมัติ** + เตือน Hard Out |
| 4 | **Mic & Member Map** | กำหนดไมค์ → สมาชิก (รองรับ “วนไมค์”) + สรุปไมค์แยกตามเพลง |
| 5 | **Live Mode** | นับถอยหลังต่อรายการ, โซนเตือน 5/2 นาที, ปุ่ม Next, **ซิงค์หลายเครื่อง (Realtime)** |
| 6 | **Export Excel** | ดาวน์โหลด Run Sheet เป็น `.xlsx` (3 ชีต: Run Sheet / Schedule / Mic Map) |

Multi-tenant SaaS + **Row-Level Security** ตั้งแต่แรก — ขยายต่อ Phase 2/3 ได้โดยไม่ต้องรื้อ

---

## 🧱 Tech Stack

- **Next.js 14** (App Router) + **TypeScript**
- **Supabase** — Auth + Postgres + Realtime + RLS
- **Tailwind CSS** + shadcn/ui
- **SheetJS (xlsx)** สำหรับ Export
- Deploy บน **Vercel**

---

## 🚀 เริ่มใช้งาน (Local)

### 1) ติดตั้ง dependencies
```bash
npm install
```

### 2) ตั้งค่า Environment
ไฟล์ `.env.local` ถูกตั้งค่าไว้ให้แล้ว (Supabase URL + Publishable Key ของโปรเจกต์)
ถ้าจะใช้โปรเจกต์ Supabase อื่น ให้แก้ตาม `.env.example`

### 3) ตั้งค่าฐานข้อมูล Supabase  ⚠️ สำคัญ
เปิด **Supabase Dashboard → SQL Editor** แล้วรัน 3 ไฟล์นี้ตามลำดับ:

1. [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) — สร้างตาราง + RLS + trigger
2. [`supabase/migrations/0002_songs.sql`](supabase/migrations/0002_songs.sql) — ตาราง Song Library + RLS + grants (Phase 2)
3. [`supabase/seed.sql`](supabase/seed.sql) — ข้อมูลตัวอย่าง **VANTAFLARE “SUNNY SEITAN-SAI”** + คลังเพลง

> ทั้งสามไฟล์รันซ้ำได้ปลอดภัย (idempotent)

**แนะนำสำหรับช่วง beta:** ปิดการยืนยันอีเมลเพื่อทดสอบเร็วขึ้น
Supabase → **Authentication → Sign In / Providers → Email → ปิด “Confirm email”**
(ถ้าเปิดไว้ ผู้ใช้ต้องกดลิงก์ยืนยันในอีเมลก่อน — แอปรองรับผ่าน `/auth/callback` อยู่แล้ว)

### 4) รันแอป
```bash
npm run dev
```
เปิด http://localhost:3000

### 5) ทดลองใช้
1. ไปที่ `/register` → สมัครสมาชิก (เลือก Role)
2. ระบบจะ **ผูกบัญชีเข้ากับ Workspace ตัวอย่าง “Capture Bomb Production” อัตโนมัติ**
3. เห็นงาน **VANTAFLARE SUNNY SEITAN-SAI** บน Dashboard → กดเข้าไปลองเล่น Setlist / Mic Map / Live Mode / Export

> ถ้าเข้าไปแล้ว Dashboard ขึ้น “ยังไม่ได้อยู่ใน Workspace” → กดปุ่ม **เข้าร่วม Demo Workspace** (เผื่อกรณีสมัครก่อนรัน seed)

---

## ☁️ Deploy ขึ้น Vercel

1. Push โค้ดขึ้น GitHub:
   ```bash
   git init
   git add .
   git commit -m "CueIQ MVP Phase 1"
   git branch -M main
   git remote add origin https://github.com/capturebombproduction/CUEIQ.git
   git push -u origin main
   ```
2. ไปที่ [vercel.com/new](https://vercel.com/new) → Import repo `CUEIQ`
3. ตั้ง **Environment Variables** (เหมือนใน `.env.local`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy
5. กลับไปที่ Supabase → **Authentication → URL Configuration**
   - ใส่ **Site URL** = โดเมน Vercel ของคุณ
   - เพิ่ม **Redirect URL** = `https://<your-domain>/auth/callback`

---

## 👥 บทบาท (Roles)

| Role | สิทธิ์ |
|---|---|
| Tenant Owner / Label Staff / **Artist Manager** | แก้ไขงาน, Setlist, Schedule, Mic Map ได้ |
| Sound / Lighting / General Staff | **ดูอย่างเดียว** (read-only) |

> สมัครใหม่ดีฟอลต์เป็น *Artist Manager* (แก้ไขได้) — สิทธิ์บังคับจริงที่ระดับฐานข้อมูลด้วย RLS

---

## 📁 โครงสร้างโปรเจกต์

```
app/
  (app)/                 # โซนที่ต้องล็อกอิน (มี header + nav)
    dashboard/           # รายการงานทั้งหมด
    events/new           # สร้างงาน
    events/[id]/         # หน้างาน: Setlist / Schedule / Mic Map (แท็บ)
    events/[id]/edit     # แก้ไขข้อมูลงาน
    events/[id]/live     # Live Mode (นับถอยหลัง + realtime)
  login, register, auth/callback
components/
  ui/                    # shadcn/ui primitives
  event/                 # event-form, schedule-editor, setlist-builder,
                         # mic-map-editor, live-mode, export-button, ...
lib/
  supabase/              # browser / server / middleware clients
  types.ts  time.ts  queries.ts  export-excel.ts
supabase/
  migrations/0001_init.sql   # schema + RLS + triggers
  seed.sql                   # VANTAFLARE demo data
docs/CueIQ_PRD_v2_Final.md
```

---

## 🗺️ ถัดไป (Phase 2 — ตาม PRD)

Song Library + Audio Upload · Drag & Drop · Song Approval + Deadline System ·
Share Links · Google Drive · Version History · Label Overview Dashboard · Multi-group

---

## 📝 หมายเหตุ

- **Run Time logic:** แต่ละรายการ = Buffer ก่อน + ความยาว + Buffer หลัง; คำนวณ Start/End/สะสม และเทียบกับ Hard Out
- **Live Mode** ใช้ Supabase Realtime **broadcast** (ช่อง `live:<eventId>`) ซิงค์สถานะระหว่างเครื่อง — ไม่ต้องตั้งค่าเพิ่ม
- คำเตือน build `process.version ... Edge Runtime` จาก `@supabase/ssr` ใน middleware เป็นเรื่องปกติ ไม่กระทบการทำงาน
```bash
npm run build   # production build
npm run lint    # eslint
```
