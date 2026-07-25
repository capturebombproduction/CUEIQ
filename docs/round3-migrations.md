# Round 3 — migrations ที่ต้องรัน (0037 + 0038)

> สถานะ: ทั้งสองไฟล์อยู่ใน repo แล้ว แต่ **ยังไม่ได้ apply ขึ้น production**
> (`0037_event_approval_guard.sql` ค้างมาตั้งแต่รอบก่อน, `0038_round3_hardening.sql`
> เพิ่งเขียนรอบนี้). ทั้งคู่เป็น DDL ล้วน **idempotent — รันซ้ำได้ ไม่พัง** และ
> ปลอดภัยกับ DB ตัวจริงที่วงกำลังใช้งานอยู่ (ไม่แตะข้อมูลแถวไหนเลย มีแต่
> policy / function / trigger)

## 0037_event_approval_guard.sql — อุดรูอนุมัติงานเอง
- Ar ของวง (editor) จะ **ตั้ง `events.status = 'approved'` เองไม่ได้แล้ว** ต้องเป็น
  ผู้อนุมัติ (admin / label_staff) — ทางเดินอื่น (draft ↔ pending_review, ส่งใหม่หลัง
  โดน reject, แก้งานที่อนุมัติแล้วโดยไม่แตะ status) เหมือนเดิมทุกอย่าง
- สร้างงานใหม่แบบ `status = 'approved'` ตั้งแต่แรกไม่ได้ → ถูกบังคับเป็น `draft`
- ปิด denylist ที่ drift: `id` / `created_by` / `created_at` ของ events

## 0038_round3_hardening.sql — ปิด 4 ช่องจากออดิตรอบ 3
1. **C4 — อีเมลตัวเองแก้ไม่ได้แล้ว**: เดิม user PATCH `profiles.email` ของตัวเองเป็น
   อีเมล Master Admin ได้ → กลายเป็นบัญชีที่แอดมินแตะไม่ได้ และหน้า Admin แสดงเป็น
   master. เพิ่ม trigger `profiles_guard_update` (ข้ามให้ service_role / ตอนสมัคร
   ซึ่ง `auth.uid()` เป็น null → เส้นแอดมินและ signup ยังทำงานปกติ)
2. **C13 — สิทธิ์เขียนของ Practice กลับมาอยู่ในวง**: `practice_songs` + `song_markers`
   เดิมใช้ `can_view_group` ซึ่ง CEO/label_staff (มองทั้งค่าย) ก็ผ่าน → CEO ที่ควร
   อ่านอย่างเดียวไปเพิ่ม/ลบเพลงซ้อมและล้างมาร์คของวงอื่นได้. เปลี่ยนเป็น
   "admin/Ar ของวง **หรือ** คนที่มี `group_roles` ของวงนั้น" → **สมาชิกวงกับ Ar เขียน
   ได้เท่าเดิมเป๊ะ**, การอ่าน (SELECT) ไม่เปลี่ยน
3. **P5 — `practice_logs` แก้แล้วย้ายวงไม่ได้**: WITH CHECK ของ UPDATE ไม่เคยเช็ค
   ขอบเขตวงของแถวใหม่ → เจ้าของโน้ตย้าย `group_id/event_id/tenant_id` ข้ามวงได้.
   ทำให้ตรงกับ policy ของ INSERT (Ar ยังแก้โน้ตของสมาชิกได้เหมือนเดิม)
4. **P6 — denylist ของ `guard_song_update`**: เติม `id` + `created_at` (ช่องเดียวกับที่
   0037 ปิดให้ events) → label_staff ที่ไม่ใช่ editor แก้ได้แค่ `copyright_status`

## คำสั่ง (รันตามลำดับเลขไฟล์)
```bash
npm run migrate supabase/migrations/0037_event_approval_guard.sql
npm run migrate supabase/migrations/0038_round3_hardening.sql
```
รวบเป็นคำสั่งเดียวก็ได้ (สคริปต์รับหลายไฟล์ ไล่ทีละไฟล์ตามลำดับ):
`npm run migrate supabase/migrations/0037_event_approval_guard.sql supabase/migrations/0038_round3_hardening.sql`
ต้องมี `SUPABASE_ACCESS_TOKEN` ใน `.env.local` ผลลัพธ์ที่ถูกต้องคือ `✓ <ไฟล์>` ทั้งสอง
บรรทัด แล้วปิดท้ายด้วย `— migration เสร็จเรียบร้อย —`

## เช็คหลังรัน
- **งาน (0037)**: Ar กดส่งงาน/แก้งานได้ตามปกติ · ปุ่มอนุมัติในหน้า Overview ของ
  admin/label_staff ยังอนุมัติผ่าน · งานที่ Ar สร้างใหม่ขึ้นเป็น `draft` (ไม่ใช่
  approved) · เดสก์ท็อปตอนออฟไลน์แก้งานแล้ว sync กลับได้เหมือนเดิม
- **โปรไฟล์ (C4)**: สร้างบัญชีใหม่ / รีเซ็ตรหัสผ่านจากหน้า Admin ยังทำงาน · รายชื่อ
  ผู้ใช้ยังโชว์อีเมลครบ · (ลองยิง PATCH `profiles.email` ของตัวเอง → ต้องขึ้น error
  `a user may not change their own email`)
- **ห้องซ้อม (C13/P5)**: สมาชิกวงเพิ่ม/เอาเพลงออกจากลิสต์ซ้อม + เพิ่ม/ลบ/ล้างมาร์ค
  ได้เหมือนเดิม · Ar ทำได้ครบ · บัญชี CEO/label_staff จะเขียนไม่ผ่านแล้ว (ขึ้น toast
  ล้มเหลว — ตั้งใจ) แต่ยังเปิดดูได้ · โน้ตซ้อม: เจ้าของแก้โน้ต shared ของตัวเองได้,
  Ar แก้/ลบโน้ตของสมาชิกได้
- **เพลง (P6)**: Ar แก้รายละเอียดเพลง/อัปไฟล์ได้เหมือนเดิม · label_staff กด
  ผ่าน/ไม่ผ่านลิขสิทธิ์ได้เหมือนเดิม
