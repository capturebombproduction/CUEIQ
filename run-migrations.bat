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
echo  จะรัน 1 ไฟล์:
echo    0039_share_lineup.sql   (ลิงก์แชร์โชว์เฉพาะคนที่ลงงานจริง
echo                             ไม่ใช่สมาชิกทั้งวง)
echo.
echo  (0037 กับ 0038 รันไปแล้วเมื่อ 25 ก.ค. ไม่ต้องรันซ้ำ)
echo.
echo  รันซ้ำได้ ไม่แตะข้อมูลแถวไหน มีแต่ policy/function/trigger
echo  ถ้าพลาดกลางทาง ระบบย้อนกลับให้ทั้งไฟล์ เหมือนไม่เคยรัน
echo.
echo ------------------------------------------------------------
echo  กด Enter เพื่อเริ่ม  /  ปิดหน้าต่างนี้ถ้ายังไม่อยากรัน
echo ------------------------------------------------------------
pause >nul

echo.
call npm run migrate supabase/migrations/0039_share_lineup.sql
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" goto failed

echo ============================================================
echo    สำเร็จ  ---  0039 ขึ้นแล้ว
echo ============================================================
echo.
echo  เช็คเร็ว ๆ: เปิดงานที่เลือกรายชื่อคนลงงานไว้ไม่ครบวง
echo  แล้วกดสร้าง/เปิดลิงก์แชร์ - ต้องเห็นเฉพาะคนที่ลงงานจริง
echo  (งานที่ยังไม่ได้เลือกรายชื่อ = โชว์ทั้งวงเหมือนเดิม)
echo.
echo  ถ้าไม่ผ่าน บอกโจเซฟินได้เลย
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
