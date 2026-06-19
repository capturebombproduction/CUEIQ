// Apply a SQL migration to the Supabase project via the Management API.
// Usage:  npm run migrate supabase/migrations/0009_event_deadline.sql [more.sql ...]
//
// Needs SUPABASE_ACCESS_TOKEN in .env.local (a Supabase Personal Access Token —
// create at https://supabase.com/dashboard/account/tokens). The token is read
// from the environment and never printed. The project ref is derived from
// NEXT_PUBLIC_SUPABASE_URL. Run via the npm script so --env-file loads .env.local.

import { readFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
const files = process.argv.slice(2);

if (!token) {
  console.error(
    "✗ ยังไม่มี SUPABASE_ACCESS_TOKEN ใน .env.local\n" +
      "  สร้าง token ที่ https://supabase.com/dashboard/account/tokens แล้วใส่บรรทัด:\n" +
      "  SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx"
  );
  process.exit(1);
}
if (!url) {
  console.error("✗ ไม่พบ NEXT_PUBLIC_SUPABASE_URL ใน .env.local");
  process.exit(1);
}
if (files.length === 0) {
  console.error("ใช้งาน: npm run migrate <ไฟล์.sql> [ไฟล์อื่น ...]");
  process.exit(1);
}

const ref = new URL(url).hostname.split(".")[0];
const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;

for (const file of files) {
  const sql = readFileSync(file, "utf8");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`✗ ${file} → HTTP ${res.status}\n${body}`);
    process.exit(1);
  }
  console.log(`✓ ${file}`);
}
console.log("— migration เสร็จเรียบร้อย —");
