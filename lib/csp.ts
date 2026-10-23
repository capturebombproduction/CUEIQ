/**
 * The Content-Security-Policy, built per request in proxy.ts around a fresh nonce.
 *
 * Shipped REPORT-ONLY first (CSP_HEADER): nothing is blocked; a violation fires a
 * `securitypolicyviolation` event, which the root layout's pre-paint script buffers
 * and ErrorMonitor logs to client_errors as kind "csp" - the same deduped,
 * throttled, RLS-gated path every other client error takes, so there is no public
 * write endpoint to abuse. After a week of real shows with no unexplained rows,
 * the header name flips to the enforcing one.
 *
 * Next.js reads the nonce off this request header (report-only included) and puts
 * it on its own scripts; the root layout reads `x-nonce` for the one inline script
 * of ours. 'strict-dynamic' then trusts what those scripts load.
 *
 * Styles stay 'unsafe-inline': the band skin is an inline <style>, React writes
 * style="" everywhere, and a nonce in style-src would switch 'unsafe-inline' off.
 *
 * Hosts the browser really talks to: the Supabase project (REST + realtime
 * websocket), and R2 over presigned URLs (song audio, feedback screenshots) -
 * `*.r2.cloudflarestorage.com` covers both URL styles without writing the account
 * id into every response. Audio and covers also play from blob: and data: URLs.
 */

/** Pre-paint: CSP violations that fire before ErrorMonitor mounts (most of them -
 *  a script refused by the policy is refused while the page parses) wait in
 *  window.__cspv for it. Capped: a page that violates on every frame must not
 *  grow it forever. Read by app/layout.tsx. */
export const CSP_BUFFER_JS = `window.__cspv=[];document.addEventListener('securitypolicyviolation',function(e){var q=window.__cspv;if(q&&q.length<20)q.push({d:e.effectiveDirective||e.violatedDirective,b:e.blockedURI,s:e.sourceFile,l:e.lineNumber,x:e.sample})});`;

export const CSP_HEADER = "Content-Security-Policy-Report-Only";

const R2 = "https://*.r2.cloudflarestorage.com";

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function buildCsp(
  nonce: string,
  { supabaseUrl, dev = false }: { supabaseUrl: string; dev?: boolean }
): string {
  const supa = new URL(supabaseUrl);
  const supaWs = `wss://${supa.host}`;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // 'unsafe-eval' only for `next dev` (React Refresh); a production build needs none.
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", R2],
    "media-src": ["'self'", "blob:", "data:", R2],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", supa.origin, supaWs, R2, "blob:", "data:", ...(dev ? ["ws:"] : [])],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}
