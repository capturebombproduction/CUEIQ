@echo off
rem ---------------------------------------------------------------------------
rem  CueIQ - double-click migration runner (Windows)
rem  Applies the SQL files listed below to the LIVE Supabase project through
rem  scripts/migrate.mjs (Management API). Needs SUPABASE_ACCESS_TOKEN in
rem  .env.local, which the npm script loads via --env-file.
rem  chcp 65001 = UTF-8, so the Thai text below renders instead of turning to
rem  mojibake in cmd's default codepage. This file must stay UTF-8 WITHOUT a BOM.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
title CueIQ - รัน migration

echo.
echo ============================================================
echo    CueIQ  ---  รัน migration ขึ้นฐานข้อมูลจริง
echo ============================================================
echo.
echo  จะรัน 2 ไฟล์ ตามลำดับ:
echo    1) 0037_event_approval_guard.sql   (กัน Ar อนุมัติงานตัวเอง)
echo    2) 0038_round3_hardening.sql       (อุดรูอีเมล + สิทธิ์ห้องซ้อม)
echo.
echo  ทั้งคู่รันซ้ำได้ ไม่แตะข้อมูลแถวไหน มีแต่ policy/function/trigger
echo  ถ้าพลาดกลางทาง ระบบย้อนกลับให้ทั้งไฟล์ เหมือนไม่เคยรัน
echo.
echo ------------------------------------------------------------
echo  กด Enter เพื่อเริ่ม  /  ปิดหน้าต่างนี้ถ้ายังไม่อยากรัน
echo ------------------------------------------------------------
pause >nul

echo.
call npm run migrate supabase/migrations/0037_event_approval_guard.sql supabase/migrations/0038_round3_hardening.sql
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" goto failed

echo ============================================================
echo    สำเร็จ  ---  migration ขึ้นครบทั้ง 2 ไฟล์แล้ว
echo ============================================================
echo.
echo  ต่อไปเปิดเว็บ cueiq-mu.vercel.app เช็ค 3 อย่างเร็ว ๆ:
echo.
echo    1) ล็อกอินเป็น Ar วงไหนก็ได้ - เปิดงาน - กดบันทึก
echo       ต้องเซฟผ่าน  (สำคัญสุด)
echo    2) สมาชิกวง - Training - ห้องซ้อม - เพิ่ม/เอาเพลงออก
echo       ต้องได้
echo    3) หน้า Admin - กดรีเซ็ตรหัสผ่านใครสักคน
echo       ต้องได้
echo.
echo  ถ้ามีอันไหนไม่ผ่าน บอกโจเซฟินได้เลย
echo.
goto done

:failed
echo ============================================================
echo    ไม่สำเร็จ  (รหัส %RC%)
echo ============================================================
echo.
echo  ฐานข้อมูลไม่ได้เปลี่ยนอะไรเลย ปลอดภัย รันซ้ำใหม่ได้
echo  ก๊อปข้อความ error ข้างบนส่งให้โจเซฟินดู
echo.
echo  ถ้าขึ้นว่าไม่รู้จักคำสั่ง npm = ยังไม่ได้ติดตั้ง Node.js
echo  หรือเปิดไฟล์นี้จากที่อื่นที่ไม่ใช่โฟลเดอร์ D:\CUEIQ
echo.

:done
echo ------------------------------------------------------------
echo  กดปุ่มอะไรก็ได้เพื่อปิดหน้าต่าง
echo ------------------------------------------------------------
pause >nul
