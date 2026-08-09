# CueIQ — ชั้นเทสต์ (รอบ 11, 2026-08-08)

> **ทำไมถึงมี:** ทุกความเสี่ยงที่เหลือของโปรเจกต์นี้เคยลงเอยที่ประโยคเดียวกัน —
> "พี่ต้องถือเครื่องไปลองที่งานเอง" เอกสารนี้คือครึ่งแรกของการเอาประโยคนั้นออก

## รันยังไง

```bash
npm test          # ทั้งสาม project (CI รันคำสั่งนี้อยู่แล้ว)
npx vitest run --project lib      # logic ล้วน ๆ (node, ไม่มี DOM)
npx vitest run --project web      # component ของเว็บ (jsdom)
npx vitest run --project desktop  # renderer ของ Electron (jsdom)
```

## สาม project — และเส้นแบ่งที่ห้ามข้าม

| project   | environment | include | ใช้กับอะไร |
|-----------|-------------|---------|-----------|
| `lib`     | node        | `lib/**/*.test.{ts,tsx}` **ยกเว้น** `lib/**/*.dom.test.{ts,tsx}` | ฟังก์ชันบริสุทธิ์ ไม่แตะ DOM/เน็ต/สตอเรจ |
| `web`     | jsdom       | `components/**/*.test.tsx`, `app/**/*.test.tsx`, `test/web/**/*.test.{ts,tsx}`, `lib/**/*.dom.test.{ts,tsx}` | คอมโพเนนต์ฝั่งเว็บ |
| `desktop` | jsdom       | `desktop/src/**/*.test.{ts,tsx}` | หน้าจอ/data layer ของแอปที่ไปงานจริง |

⚠️ ทุก glob เป็น `{ts,tsx}` ทั้งคู่โดยตั้งใจ: เคยเป็น `.ts` อย่างเดียวฝั่งหนึ่งกับ `.tsx` อย่างเดียว
อีกฝั่ง ผลคือ `lib/x.dom.test.tsx` ไปรันใน node และ `test/web/x.test.ts` **ไม่ถูกเก็บโดย project ไหนเลย**
— ไม่มีใครฟ้อง มันแค่ไม่เคยรัน ซึ่งแย่กว่าไม่มีเทสต์

⚠️ **`lib/**/*.dom.test.ts` ไม่ใช่การตั้งชื่อสวย ๆ** — มันคือทางเดียวที่ทำให้โมดูลซึ่งต้องใช้
*เบราว์เซอร์* (IndexedDB, localStorage) ไม่ไปรันใน project `lib` ที่ไม่มีของพวกนั้น ถ้าวางผิดที่
เทสต์จะ **ผ่าน** โดยไปเข้า branch "storage ใช้ไม่ได้" ของโมดูลนั้นแทน — เขียวทั้งที่ไม่ได้ทดสอบอะไรเลย

## กฎที่เจ็บมาแล้ว

1. **vitest globals ปิดอยู่** ทุกไฟล์ต้อง `import { describe, it, expect, vi } from "vitest"` เอง —
   เพราะ `npx tsc --noEmit` ของ root ตรวจไฟล์เทสต์ด้วย
2. **mock ที่ specifier `"@/lib/supabase/client"` เท่านั้น** ไม่ใช่ path ที่ resolve แล้ว —
   ในทั้ง repo ไม่มี `createClient()` ระดับ module scope สักที่ ทุก call site อยู่ในบอดี้/effect/handler
   ดังนั้น `vi.mock` บรรทัดเดียวคุมการต่อเน็ตได้หมด
3. **`vi.mock` ถูก hoist ขึ้นเหนือทุกตัวแปร** helper ที่เขียนไว้ข้างบนแล้วเรียกในโรงงาน mock จะพัง
   ด้วยข้อความที่ชี้ไปผิดที่ (`Cannot access X before initialization` จาก import ของคอมโพเนนต์เอง)
   ใช้ `vi.hoisted()` หรือเขียนเต็ม ๆ ทีละบรรทัด
4. **อย่ารอเวลาจริง** ทุกการเปลี่ยนสถานะต้อง *ถูกสั่ง* — dispatch event, เรียก handler ที่บันทึกไว้,
   หรือ `vi.advanceTimersByTime` เทสต์ที่รอเวลาจริงคือตัวที่แดงตอนตีสองบน runner ที่โหลดหนัก
5. **ยืนยันด้วยโครงสร้าง ไม่ใช่ข้อความไทย** (role, test id, `data-*`) — ข้อความไทยเปราะต่อการแก้คำ
   และเป็น string ชนิดเดียวที่ repo นี้มีประวัติทำพังเงียบ ๆ

### กับดักใหญ่: React สองก๊อปปี้

`desktop/` เป็น npm project ของตัวเอง จึงมี `react`, `react-dom`, `react-router-dom`, `lucide-react`
ชุดที่สองใน `desktop/node_modules` — และ vitest ส่ง node_modules ให้ Node resolve เอง **alias ของ vite
ไม่ได้ถูกถาม** ผลคือ `lucide-react` ลาก React ของ desktop เข้ามา แล้วทุก hook พังด้วยข้อความที่ชี้ไปผิดไฟล์
(`Cannot read properties of null (reading 'useContext')`) `vitest.config.ts` เลย **คำนวณรายการ pin จาก
`desktop/package.json` เอง** และโยน error ถ้าเวอร์ชัน major ของสองฝั่งไม่ตรงกัน — อย่าลบทิ้ง

## `data-cueiq-screen` — หกหน้าจอที่แยกกันไม่ออกด้วยตา

`boot` · `login` · `shell` (+ `data-cueiq-tenant`) · `shell-fallback` (+ `data-cueiq-failed`) ·
`app-error` · `quick-show` — สี่ในหกเป็นการ์ดกลางจอที่ขึ้นคำว่า "กำลังโหลด…" เหมือนกัน และเส้นแบ่ง
`shell` กับ `shell-fallback` คือความต่างระหว่าง "แคชออฟไลน์ทำงาน" กับ "ล็อกอินได้แต่ไม่มีข้อมูลอะไรเลย"
— หนึ่งคำบนจอ แต่คนละโชว์กันในความจริง

## Smoke ของแอปจริง (การทดสอบบนเครื่องบิน แบบเครื่องทำเอง)

```bash
# ไม่ต้อง package — รัน main.cjs ตัวเดียวกันผ่าน electron ตรง ๆ
node desktop/scripts/run-smoke.mjs \
  --exe desktop/node_modules/electron/dist/electron.exe --app desktop

# หรือกับตัวที่ package แล้ว (แบบที่ CI ทำ)
node desktop/scripts/run-smoke.mjs --exe desktop/release/win-unpacked/CueIQ.exe
```

สามสถานการณ์:

| ชื่อ | เงื่อนไข | ต้องได้ |
|------|----------|---------|
| `control` | ไม่มี session, เน็ตปกติ | หน้า `login` |
| `airplane` | session หมดอายุใน localStorage, DNS ตาย, request ถูก cancel, `navigator.onLine` = false | `#/dashboard` + หน้าจอ `shell` + ชื่อวงจากแคช + **จำนวนงานตรงเป๊ะ** |
| **`handover`** | **ไม่ปลูกอะไรเลย** — แอปพิมพ์รหัสเข้าฟอร์มล็อกอินจริงใส่ Supabase จำลอง, อ่านเอง, **เขียนแคชเอง** → *แล้วค่อย* ตัดเน็ต → บูตเย็น | เหมือน `airplane` แต่แคชทุกไบต์เป็นของที่แอปผลิตเอง |
| `quick-show-offline` | ไม่มีบัญชี ไม่มีเน็ต เปิดที่ `/my-show` | Quick Show เปิดได้ |

`handover` คือครึ่งที่ `airplane` พิสูจน์ไม่ได้: การ seed แคชด้วยมือมัน**ข้าม**โค้ดที่เขียนแคช จึงบอกได้แค่ว่า
"อ่านออฟไลน์ได้" ไม่ได้บอกว่า "ตอนออนไลน์เขียนถูกไหม" ตัวนี้ใช้ stub ของ Supabase (`desktop/scripts/smoke-backend.mjs`,
node:http ล้วน ไม่มี dependency) ที่ main process **เสิร์ฟให้เอง** ผ่าน `ses.protocol.handle("https", …)` —
ไม่ใช่ redirect เพราะ redirect ข้าม origin จะ**ถอด header `Authorization` ทิ้ง**ตามสเปก fetch (เจอมาแล้ว:
`200 POST /auth/v1/token` ตามด้วย `401 GET /auth/v1/user`) และที่สำคัญคือ **build ไม่ถูกแตะเลย** เพราะ URL ของ
Supabase ถูก bake เข้า bundle ตั้งแต่ตอน build

**สามอย่างที่ทำให้เทสต์นี้โกหกไม่ได้** (ทั้งหมดอยู่ท้าย `run-smoke.mjs`):

1. **cross-check ตัวที่ 1 — seed ได้ผลจริงไหม** ทุกวิธีที่ seed จะหายไปเงียบ ๆ (project ref ผิด,
   JSON พัง, เขียน localStorage ไม่ติด, reload กินไป) ล้วนจบด้วยอาการเดียว — แอปที่ **ไม่ได้ล็อกอิน**
   ซึ่งคือสิ่งที่ `control` คาดหวังพอดี ดังนั้นถ้าสองการบูตลงหน้าจอเดียวกัน งานแดงทันทีไม่ว่าหน้าจอไหน
2. **cross-check ตัวที่ 2 — "ตัดเน็ต" แปลว่าอะไร** ถ้า `control` (ที่ไม่ได้ตัดอะไรเลย) ก็ยิงไม่ถึง
   Supabase เหมือนกัน แปลว่าเครื่องนั้นไม่มีเน็ตตั้งแต่แรก และ "เน็ตถูกตัด" ก็ไม่ได้พิสูจน์อะไร → แดง
3. **appVersion** เทียบกับ `desktop/package.json` — กัน `win-unpacked` เก่าค้างถูกเอามา smoke แทนของจริง

`--only <ชื่อ>` มีไว้ไล่ทีละอันตอนแก้ แต่มันจะพิมพ์ `::warning::` เพราะ cross-check ทั้งสองต้องใช้
สองสถานการณ์ — CI ต้องรันครบเสมอ และ scenario ที่ไม่ตั้ง `CUEIQ_SMOKE_EXPECT` จะถูกปฏิเสธไม่ให้รันเลย
(คำถามที่อ่อนที่สุดคือ "มีอะไรเรนเดอร์ไหม" ซึ่งหน้าจอ loading ก็ตอบผ่าน)

รันที่ไหน: `.github/workflows/ci.yml` job `desktop-smoke` รันทุก push (ผ่าน electron ตรง),
`.github/workflows/desktop-build.yml` รันกับ `.exe` จริงก่อน publish ทุก tag

### สิ่งที่ smoke นี้ **ไม่ได้** พิสูจน์ — อ่านก่อนอ้างว่าเขียว

- ~~การ seed แคชข้ามโค้ดที่เขียนแคช~~ — **ปิดช่องนี้แล้วด้วย `handover`** (ดูตารางด้านบน) `airplane`
  ยังคง seed อยู่โดยตั้งใจ เพราะเป็นตัวเร็วที่ไม่ต้องมี backend คอยเฝ้าเส้นทางอ่าน
- stub **ไม่ได้เสิร์ฟทุกอย่าง**: `staff_contacts` / `song_markers` / `practice_songs` และ *การเขียน* ทุกชนิด
  ตอบ 501 พร้อมบอกชื่อ path — ถ้าวันหนึ่งมี scenario เดินไปถึง จะเห็นทันทีว่าขาดอะไร ไม่ใช่ผ่านแบบเงียบ ๆ
- รัน `win-unpacked` ไม่ใช่ตัวที่ติดตั้งผ่าน NSIS — ปัญหาเฉพาะตอนติดตั้ง (path มีเว้นวรรค/ภาษาไทย,
  per-user install) ยังไม่ถูกทดสอบ
- jsdom ไม่ decode เสียง ไม่บังคับ autoplay policy ไม่รันสองเครื่อง — เทสต์ฝั่งนั้นพิสูจน์ *เจตนา*
  (สั่งถูกคำสั่ง, mute ถูกตัว, ส่ง prop ถูก) ไม่ใช่ *ฟิสิกส์* (เสียงออกลำโพงจริง)

## เครื่องนี้

- **ห้าม** ส่งไฟล์ source วนผ่าน PowerShell (`Get-Content | Set-Content` ใน PS 5.1 อ่าน UTF-8-ไม่มี-BOM
  เป็น ANSI แล้วเขียนกลับ → ภาษาไทยกลายเป็น mojibake ทั้งไฟล์ โดย tsc/lint/เทสต์ยังเขียวหมด)
  ใช้ Write/Edit tool หรือ `node -e` ที่ระบุ `'utf8'` ทั้งขาอ่านและขาเขียน
- เกตที่จับเรื่องนี้คือ `node scripts/check-encoding.mjs` — เกตเดียวในรีโปที่ดูที่ *ไบต์* ไม่ใช่ไวยากรณ์
  อ่านทั้งไฟล์ที่ track แล้วและไฟล์ใหม่ที่ยังไม่ `git add` (ใน CI ที่ checkout สะอาดจะไม่มีอย่างหลัง
  เกตนี้จึงช่วยได้เฉพาะตอนรันในเครื่อง) ไฟล์ที่ *ต้อง* มี mojibake จริง ๆ ขอยกเว้นได้ด้วยการใส่
  มาร์กเกอร์บรรทัดเดียวไว้ในไฟล์ (ข้อความเต็มของมาร์กเกอร์ดูที่ตัวแปร `OPT_OUT` ใน
  `scripts/check-encoding.mjs` — อย่าคัดลอกมาวางในเอกสาร ไม่งั้นเอกสารจะถูกยกเว้นไปด้วย)
  ทุกครั้งที่รัน เกตจะพิมพ์รายชื่อไฟล์ที่ถูกยกเว้นออกมาเสมอ ให้ไล่ดูว่ามีอะไรหลุดเข้าไปหรือเปล่า
- ขอบเขตของเกตนี้ **แคบโดยตั้งใจ** จับแค่ **ไทย · วรรคตอน (— – “ ” … •) · ละตินมีสระ (é ß ñ ×) ·
  สัญลักษณ์ Latin-1 (NBSP · ° © «) · emoji 4 ไบต์** — **ไม่จับ** CJK/คานะ/ฮันกึล, กรีก, ซีริลลิก,
  ลูกศรกับสัญลักษณ์ (→ ✅ ⭐), € ™ และ Latin Extended-A (ł č ğ) เพราะแพตเทิร์นที่กว้างพอจะจับพวกนั้น
  จะไปฟ้องผิดใส่ข้อความปกติ (วัดแล้ว: เวอร์ชันกว้างฟ้องผิด 11 จาก 53 สตริงที่ปกติดี เช่น บรรทัดขนาด
  `1920 × 1080` ที่ใช้ NBSP และฝรั่งเศสที่พิมพ์ถูกหลัก) รายการเต็มว่าอะไรจับ/ไม่จับอยู่หัวไฟล์
  `scripts/mojibake.mjs` และถูกล็อกไว้ทั้งสองด้านด้วย `lib/mojibake.test.ts`
- Windows Application Control บนเครื่องนี้บล็อก `.exe` ที่เพิ่ง build — จึงมีโหมด `--app` ให้รัน smoke
  ผ่าน electron ได้โดยไม่ต้อง package
