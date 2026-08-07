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
| `lib`     | node        | `lib/**/*.test.ts(x)` | ฟังก์ชันบริสุทธิ์ ไม่แตะ DOM/เน็ต/สตอเรจ |
| `web`     | jsdom       | `components/**/*.test.tsx`, `app/**/*.test.tsx`, `test/web/**`, `lib/**/*.dom.test.ts` | คอมโพเนนต์ฝั่งเว็บ |
| `desktop` | jsdom       | `desktop/src/**/*.test.ts(x)` | หน้าจอ/data layer ของแอปที่ไปงานจริง |

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
| `quick-show-offline` | ไม่มีบัญชี ไม่มีเน็ต เปิดที่ `/my-show` | Quick Show เปิดได้ |

**ตัวที่ทำให้เทสต์นี้โกหกไม่ได้** คือ cross-check ท้ายสคริปต์: ทุกวิธีที่ seed จะหายไปเงียบ ๆ
(project ref ผิด, JSON พัง, เขียน localStorage ไม่ติด, reload กินไป) ล้วนจบด้วยอาการเดียว —
แอปที่ **ไม่ได้ล็อกอิน** ซึ่งคือสิ่งที่ `control` คาดหวังพอดี ดังนั้นถ้าสองการบูตลงหน้าจอเดียวกัน
งานจะแดงทันทีไม่ว่าจะเป็นหน้าจอไหน

รันที่ไหน: `.github/workflows/ci.yml` job `desktop-smoke` รันทุก push (ผ่าน electron ตรง),
`.github/workflows/desktop-build.yml` รันกับ `.exe` จริงก่อน publish ทุก tag

### สิ่งที่ smoke นี้ **ไม่ได้** พิสูจน์ — อ่านก่อนอ้างว่าเขียว

- การ seed `cueiq:cache:*` **ข้าม** โค้ดที่เขียนแคชนั้น จึงพิสูจน์แค่ *เส้นทางอ่าน* ออฟไลน์กับประตูล็อกอิน
  ไม่ได้พิสูจน์ว่า session ตอนออนไลน์เติมแคชถูกก่อนเน็ตจะหลุด
- รัน `win-unpacked` ไม่ใช่ตัวที่ติดตั้งผ่าน NSIS — ปัญหาเฉพาะตอนติดตั้ง (path มีเว้นวรรค/ภาษาไทย,
  per-user install) ยังไม่ถูกทดสอบ
- jsdom ไม่ decode เสียง ไม่บังคับ autoplay policy ไม่รันสองเครื่อง — เทสต์ฝั่งนั้นพิสูจน์ *เจตนา*
  (สั่งถูกคำสั่ง, mute ถูกตัว, ส่ง prop ถูก) ไม่ใช่ *ฟิสิกส์* (เสียงออกลำโพงจริง)

## เครื่องนี้

- **ห้าม** ส่งไฟล์ source วนผ่าน PowerShell (`Get-Content | Set-Content` ใน PS 5.1 อ่าน UTF-8-ไม่มี-BOM
  เป็น ANSI แล้วเขียนกลับ → ภาษาไทยกลายเป็น mojibake ทั้งไฟล์ โดย tsc/lint/เทสต์ยังเขียวหมด)
  ใช้ Write/Edit tool หรือ `node -e` ที่ระบุ `'utf8'` ทั้งขาอ่านและขาเขียน
- Windows Application Control บนเครื่องนี้บล็อก `.exe` ที่เพิ่ง build — จึงมีโหมด `--app` ให้รัน smoke
  ผ่าน electron ได้โดยไม่ต้อง package
