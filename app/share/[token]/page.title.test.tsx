// The share page's tab / chat-preview title.
//
// 2026-10-30, hunt 10: the fallback was "Run Sheet · CueIQ", and the root layout's title
// template ("%s · CueIQ") adds the suffix again - a dead, expired or revoked link, or a
// failed read, showed "Run Sheet · CueIQ · CueIQ". The page's own title never carries it.
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => h.result }),
}));
// app/layout.tsx is imported only for its title template (as app/root-layout.test.tsx does)
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/font/google", () => ({
  Kanit: () => ({ variable: "font-kanit" }),
  Barlow_Condensed: () => ({ variable: "font-barlow" }),
}));

import { generateMetadata } from "@/app/share/[token]/page";
import { metadata as rootMetadata } from "@/app/layout";

const TOKEN = "0b2c4f0e-1111-4111-8111-111111111111";
const titleFor = async () =>
  (await generateMetadata({ params: Promise.resolve({ token: TOKEN }) })).title as string;
/** What the browser shows: the page title through the root layout's template. */
const shown = (t: string) =>
  (rootMetadata.title as { template: string }).template.replace("%s", t);

describe("share page · title", () => {
  it("a link that opens nothing reads 'Run Sheet · CueIQ', once", async () => {
    h.result = { data: null, error: null };
    expect(shown(await titleFor())).toBe("Run Sheet · CueIQ");
  });

  it("a failed read says the same, once", async () => {
    h.result = { data: null, error: { message: "fetch failed", code: "" } };
    expect(shown(await titleFor())).toBe("Run Sheet · CueIQ");
  });

  it("a live link is named after its show", async () => {
    h.result = { data: { event: { name: "Ichiban idol vol.26 Halloween" } }, error: null };
    expect(shown(await titleFor())).toBe("Ichiban idol vol.26 Halloween · Run Sheet · CueIQ");
  });
});
