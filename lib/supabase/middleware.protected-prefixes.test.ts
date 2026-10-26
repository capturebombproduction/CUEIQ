// 2026-10-27 hunt 3 (admin): PROTECTED_PREFIXES ("keep in sync with the routes under
// app/(app)") had no /crew and no /feedback. A signed-out tap on the
// "ทีมงานตอบฟีดแบคของคุณแล้ว" push (link /feedback) was not sent to /login?next=/feedback;
// the (app) layout's bare redirect("/login") dropped where they were going, and after
// signing in they landed on /dashboard instead of the answer. The second test keeps the
// list in sync with the folder from now on.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://x.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

import { updateSession } from "@/lib/supabase/middleware";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function signedOut(p: string) {
  const res = await updateSession(new NextRequest(`https://cueiq-mu.vercel.app${p}`));
  return res.headers.get("location");
}

describe("proxy: a signed-out hit on an (app) route goes to /login with `next`", () => {
  it.each(["/feedback", "/crew"])("%s", async (p) => {
    expect(await signedOut(p)).toContain(`/login?next=${encodeURIComponent(p)}`);
  });

  it("covers every route folder under app/(app)", async () => {
    const routes = fs
      .readdirSync(path.join(ROOT, "app/(app)"), { withFileTypes: true })
      // route groups "(x)", private "_x" and parallel "@x" folders add no URL segment
      .filter((d) => d.isDirectory() && !/^[(_@]/.test(d.name))
      .map((d) => `/${d.name}`);
    expect(routes.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const r of routes) {
      if (!(await signedOut(r))?.includes(`/login?next=${encodeURIComponent(r)}`)) missing.push(r);
    }
    expect(missing).toEqual([]);
  });

  it("leaves the public pages alone", async () => {
    expect(await signedOut("/login")).toBeNull();
    expect(await signedOut("/")).toBeNull();
  });
});
