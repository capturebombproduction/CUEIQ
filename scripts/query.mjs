// One-off SQL query helper via the Supabase Management API.
// Usage: node --env-file=.env.local scripts/query.mjs "select ..."
// Prints the JSON result rows to stdout. Read-only by intent; do not commit.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
const sql = process.argv[2];
if (!token || !url || !sql) {
  console.error("need SUPABASE_ACCESS_TOKEN, NEXT_PUBLIC_SUPABASE_URL, and a SQL arg");
  process.exit(1);
}
const ref = new URL(url).hostname.split(".")[0];
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}\n${body}`);
  process.exit(1);
}
console.log(body);
