import { describe, expect, it } from "vitest";
import { buildCsp, CSP_HEADER, newNonce } from "@/lib/csp";

const SUPA = "https://abcdefgh.supabase.co";
const parse = (csp: string) =>
  Object.fromEntries(
    csp.split(";").map((d) => {
      const [k, ...v] = d.trim().split(/\s+/);
      return [k, v];
    })
  );

describe("buildCsp", () => {
  it("lets only the request's nonce run inline script, and what it loads", () => {
    const p = parse(buildCsp("n0nce", { supabaseUrl: SUPA }));
    expect(p["script-src"]).toEqual(["'self'", "'nonce-n0nce'", "'strict-dynamic'"]);
    expect(p["script-src"]).not.toContain("'unsafe-inline'");
    expect(p["script-src"]).not.toContain("'unsafe-eval'");
  });

  // A nonce (or hash) in style-src makes browsers IGNORE 'unsafe-inline', and the
  // band skin is an inline <style> - every band colour would vanish on enforce.
  it("keeps inline styles working: no nonce in style-src", () => {
    const p = parse(buildCsp("n0nce", { supabaseUrl: SUPA }));
    expect(p["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("reaches the Supabase project over https and its realtime websocket, and R2", () => {
    const p = parse(buildCsp("x", { supabaseUrl: SUPA }));
    expect(p["connect-src"]).toEqual(
      expect.arrayContaining(["'self'", SUPA, "wss://abcdefgh.supabase.co", "https://*.r2.cloudflarestorage.com"])
    );
    expect(p["media-src"]).toEqual(expect.arrayContaining(["blob:", "https://*.r2.cloudflarestorage.com"]));
    expect(p["img-src"]).toEqual(expect.arrayContaining(["data:", "blob:"]));
  });

  it("is never framed, never plugs in, never re-bases", () => {
    const p = parse(buildCsp("x", { supabaseUrl: SUPA }));
    expect(p["frame-ancestors"]).toEqual(["'none'"]);
    expect(p["object-src"]).toEqual(["'none'"]);
    expect(p["base-uri"]).toEqual(["'self'"]);
  });

  it("adds eval + the HMR socket for next dev only", () => {
    const p = parse(buildCsp("x", { supabaseUrl: SUPA, dev: true }));
    expect(p["script-src"]).toContain("'unsafe-eval'");
    expect(p["connect-src"]).toContain("ws:");
  });

  it("ships report-only until a week of real shows says otherwise", () => {
    expect(CSP_HEADER).toBe("Content-Security-Policy-Report-Only");
  });
});

describe("newNonce", () => {
  it("is 128 random bits, base64, different every request", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
  });
});
