// 2026-10-30, hunt 11: the web root mounts AuthCookieKeeper, so after every token refresh
// the session cookie is re-set by the server (app/api/auth/cookie-keep) and WebKit's 7-day
// cap on script-written cookies no longer signs a member out between two shows a week
// apart. The desktop app keeps its session in localStorage and never renders this layout;
// it must not mount the keeper (its file:// origin has no /api to call).
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-nonce": "n0nce" }),
}));
vi.mock("next/font/google", () => ({
  Kanit: () => ({ variable: "font-kanit" }),
  Barlow_Condensed: () => ({ variable: "font-barlow" }),
}));

import RootLayout from "@/app/layout";
import { AuthCookieKeeper } from "@/components/auth-cookie-keeper";

type El = ReactElement<Record<string, unknown>>;
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props ?? {})) all(v, out);
  }
  return out;
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("root layout - the session cookie keeper", () => {
  it("is mounted once on every web page", async () => {
    const tree = all(await RootLayout({ children: <div /> }));
    expect(tree.filter((el) => el.type === AuthCookieKeeper)).toHaveLength(1);
  });

  it("is never mounted by the desktop app", () => {
    const root = path.resolve(__dirname, "../desktop/src");
    const users = filesUnder(root).filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /auth-cookie-keeper|AuthCookieKeeper|app\/layout["']/.test(src);
    });
    expect(users).toEqual([]);
  });
});
